import {TIMELINE_OUTPUT_PRESETS,isTimelineExportDelivery} from '@mioon/contracts';
import {run,runStreaming} from './media-runtime.mjs';
import {throwIfMediaAborted,waitForMediaProcesses,MEDIA_TERMINATION_POLICY} from './media-processes.mjs';

// Explicit local-compute check, separate from read-only source preflight. This
// intentionally has one active check per Node process, no wait queue or cache.
// The operation budget reserves the runner's fixed direct-child reap allowance.
export const TIMELINE_EXPORT_CAPABILITY_LIMITS=Object.freeze({concurrent:1,queued:0,totalMs:15000,
 computeMs:15000-MEDIA_TERMINATION_POLICY.graceMs-MEDIA_TERMINATION_POLICY.reapMs,
 frames:3,stdoutBytes:1024*1024,encoderListBytes:128*1024,stderrBytes:64*1024});
let active=null;
const result=(status,code)=>({status,code});
const error=code=>Object.assign(Error('The selected local export profile could not be verified.'),{code});
const validDelivery=delivery=>TIMELINE_OUTPUT_PRESETS.some(timeline=>isTimelineExportDelivery(delivery,timeline));
function advertisedEncoders(listing){
 const lines=listing.split(/\r?\n/),separator=lines.findIndex(line=>line.trim()==='------');
 if(!lines.some(line=>line.trim()==='Encoders:')||separator<0)throw error('EXPORT_CAPABILITY_FAILED');
 const rows=lines.slice(separator+1).filter(line=>line.trim()),names=rows.map(line=>/^\s*[VAS][A-Z.]{5}\s+([A-Za-z0-9_-]+)\s+\S/.exec(line)?.[1]);
 // Absence is negative evidence only from a complete recognizable listing.
 // Empty, truncated/malformed, or otherwise unrecognized output is unknown.
 if(!names.length||names.some(name=>!name))throw error('EXPORT_CAPABILITY_FAILED');
 return new Set(names);
}

/** Fixed argv shared by the actual segment encoder and the synthetic proof. */
export function timelineExportVideoArgs(delivery){
 if(!validDelivery(delivery))throw error('INVALID_TIMELINE_SNAPSHOT');
 const p=delivery.effective;
 return ['-c:v',p.videoCodec,'-preset',p.preset,...(p.rateControl.mode==='crf'?['-crf',String(p.rateControl.crf)]:['-b:v',`${p.rateControl.targetKbps}k`]),
  '-threads','2','-bf',String(p.bFrames),'-g',String(p.gopFrames),'-pix_fmt',p.pixelFormat,'-r',String(p.fps),'-video_track_timescale',String(p.videoTrackTimescale)];
}

// This is deliberately a small check of our own bounded synthetic MP4 output,
// not a general media parser. Only the required top-level boxes and the two
// fixed sample entries are inspected; real exports are separately ffprobed.
function boxes(bytes,begin=0,end=bytes.length){
 const found=[];
 for(let at=begin;at<end;){
  if(end-at<8)throw error('EXPORT_CAPABILITY_FAILED');
  const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);
  if(size<8||size>end-at||found.length>=128)throw error('EXPORT_CAPABILITY_FAILED');
  found.push({type,begin:at+8,end:at+size});at+=size;
 }
 return found;
}
function child(bytes,parent,type){const matches=boxes(bytes,parent.begin,parent.end).filter(box=>box.type===type);if(matches.length!==1)throw error('EXPORT_CAPABILITY_FAILED');return matches[0];}
function verifyProof(bytes,p){
 const top=boxes(bytes),of=type=>top.filter(box=>box.type===type);
 if(of('ftyp').length!==1||of('moov').length!==1||!of('moof').length||!of('mdat').some(box=>box.end>box.begin))throw error('EXPORT_CAPABILITY_FAILED');
 const tracks=boxes(bytes,of('moov')[0].begin,of('moov')[0].end).filter(box=>box.type==='trak');
 if(tracks.length!==2)throw error('EXPORT_CAPABILITY_FAILED');
 const types=[];
 for(const track of tracks){
  const mdia=child(bytes,track,'mdia'),handler=child(bytes,mdia,'hdlr'),minf=child(bytes,mdia,'minf'),stbl=child(bytes,minf,'stbl'),stsd=child(bytes,stbl,'stsd');
  if(handler.end-handler.begin<12||stsd.end-stsd.begin<8||bytes.readUInt32BE(stsd.begin+4)!==1)throw error('EXPORT_CAPABILITY_FAILED');
  const type=bytes.toString('ascii',handler.begin+8,handler.begin+12),entries=boxes(bytes,stsd.begin+8,stsd.end),entry=entries[0];
  if(entries.length!==1)throw error('EXPORT_CAPABILITY_FAILED');
  if(type==='vide'){
   if(entry.type!=='avc1'||entry.end-entry.begin<78||bytes.readUInt16BE(entry.begin+24)!==p.width||bytes.readUInt16BE(entry.begin+26)!==p.height)throw error('EXPORT_CAPABILITY_FAILED');
   const config=boxes(bytes,entry.begin+78,entry.end);
   if(!config.some(box=>box.type==='avcC'&&box.end-box.begin>=7))throw error('EXPORT_CAPABILITY_FAILED');
  }else if(type==='soun'){
   if(entry.type!=='mp4a'||entry.end-entry.begin<28||bytes.readUInt16BE(entry.begin+16)!==p.audioChannels||bytes.readUInt32BE(entry.begin+24)/65536!==p.audioSampleRate)throw error('EXPORT_CAPABILITY_FAILED');
   if(!boxes(bytes,entry.begin+28,entry.end).some(box=>box.type==='esds'&&box.end-box.begin>=8))throw error('EXPORT_CAPABILITY_FAILED');
  }else throw error('EXPORT_CAPABILITY_FAILED');
  types.push(type);
 }
 if(new Set(types).size!==2)throw error('EXPORT_CAPABILITY_FAILED');
}

/** Actual selected-profile encode/options/MP4-mux proof, without user media,
 * private scratch files, shell argv, providers, network, or encoder fallbacks.
 * Fragmented MP4 is required only for the nonseekable bounded proof pipe; the
 * published artifact continues to use the frozen +faststart MP4 render path.
 * Results are observations, never authority tokens for a later render.
 */
export async function inspectTimelineExportCapability(delivery,{signal}={}){
 throwIfMediaAborted(signal);
 if(!validDelivery(delivery))return result('incomplete','EXPORT_CAPABILITY_CONFIGURATION');
 if(active)return result('incomplete','EXPORT_CAPABILITY_BUSY');
 const token={};active=token;
 const deadline=performance.now()+TIMELINE_EXPORT_CAPABILITY_LIMITS.computeMs;
 const timeout=()=>{const left=Math.floor(deadline-performance.now());if(left<=0)throw error('MEDIA_TIMEOUT');return left;};
 let unconfirmed=false;
 try{
  const listing=await run('ffmpeg',['-hide_banner','-encoders'],{signal,timeout:timeout(),maxStdoutBytes:TIMELINE_EXPORT_CAPABILITY_LIMITS.encoderListBytes,maxStderrBytes:TIMELINE_EXPORT_CAPABILITY_LIMITS.stderrBytes});
  throwIfMediaAborted(signal);
  const encoders=advertisedEncoders(listing);
  if(!encoders.has('libx264')||!encoders.has('aac'))return result('unavailable','EXPORT_CAPABILITY_UNSUPPORTED');
  const p=delivery.effective,chunks=[];
  const output=await runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-filter_complex_threads','1',
   '-f','lavfi','-i','color=c=black:s=64x64:r=30:d=0.1','-f','lavfi','-i','anullsrc=r=48000:cl=stereo:d=0.1',
   '-filter_complex',`[0:v]scale=${p.width}:${p.height}:flags=${p.scaling},setsar=1,format=${p.pixelFormat}[v]`,
   '-map','[v]','-map','1:a:0',...timelineExportVideoArgs(delivery),'-frames:v',String(TIMELINE_EXPORT_CAPABILITY_LIMITS.frames),
   '-c:a',p.audioCodec,'-b:a',`${p.audioKbps}k`,'-ar',String(p.audioSampleRate),'-ac',String(p.audioChannels),'-t','0.1',
   '-movflags','+frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1'],
   {signal,timeout:timeout(),maxStdoutBytes:TIMELINE_EXPORT_CAPABILITY_LIMITS.stdoutBytes,maxStderrBytes:TIMELINE_EXPORT_CAPABILITY_LIMITS.stderrBytes,onStdout:chunk=>{chunks.push(Buffer.from(chunk));}});
  throwIfMediaAborted(signal);
  verifyProof(Buffer.concat(chunks,output.stdoutBytes),p);
  return result('available','EXPORT_CAPABILITY_AVAILABLE');
 }catch(failure){
  if(failure.terminationUnconfirmed){unconfirmed=true;throw failure;}
  if(signal?.aborted||failure.code==='MEDIA_CANCELLED'){throwIfMediaAborted(signal);throw failure;}
  const codes={MEDIA_SPAWN_FAILED:['unavailable','EXPORT_CAPABILITY_TOOL_UNAVAILABLE'],MEDIA_INVALID_CONFIGURATION:['incomplete','EXPORT_CAPABILITY_CONFIGURATION'],
   MEDIA_TIMEOUT:['incomplete','EXPORT_CAPABILITY_TIMEOUT'],MEDIA_OUTPUT_LIMIT:['incomplete','EXPORT_CAPABILITY_OUTPUT_LIMIT']};
  return result(...(codes[failure.code]||['incomplete','EXPORT_CAPABILITY_FAILED']));
 }finally{
  if(unconfirmed){
   // The runner retains the unconfirmed owned-child fence. Keep this stricter
   // capability slot held too until an actual close is observed, never timeout.
   void waitForMediaProcesses({signal}).then(()=>{if(active===token)active=null;});
  }else if(active===token)active=null;
 }
}

export async function assertTimelineExportCapability(delivery,options){
 const capability=await inspectTimelineExportCapability(delivery,options);
 if(capability.status!=='available')throw error(capability.code);
 return capability;
}
