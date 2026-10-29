import {JFIF_INPUT_ARGS,JFIF_RGB24_FILTER,jpegDecodeIdentity} from './timeline-jpeg-decode.ts';
import type {TimelineJpegEvidence} from '../../contracts/src/timeline-colour.ts';
import {constants,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createTimelineFloatStaging} from './timeline-float-staging.ts';
import {timelineImageDisplayTable,timelineImageFilterGraph,TIMELINE_IMAGE_DISPLAY_PROFILE_ID,TIMELINE_IMAGE_RESIZE_PROFILE_ID,TIMELINE_IMAGE_DISPLAY_TABLE_SHA256} from './timeline-image-filter.ts';

type StagingRuntime=Parameters<typeof createTimelineFloatStaging>[2];
interface Options {signal?:AbortSignal;beforeEffect?:()=>void}
interface LayerRuntime extends StagingRuntime {
 run(command:string,args:string[],options:{timeout:number;maxStdoutBytes:number;maxStderrBytes:number;signal?:AbortSignal;beforeEffect:()=>void}):Promise<unknown>;
 waitForMediaProcesses(options:{signal?:AbortSignal}):Promise<unknown>;
}
export interface TimelineImageLayerInput {
 readonly clipId:string;readonly assetSha256:string;readonly sourcePath:string;
 readonly sourceWidth:number;readonly sourceHeight:number;readonly width:number;readonly height:number;
 readonly creativeLutPath?:string;
 /** A clip transform's crop in whole source pixels; absent keeps the historical layer. */
 readonly crop?:{readonly x:number;readonly y:number;readonly width:number;readonly height:number};
 /** Present only for the separately admitted JPEG generation. */
 readonly jpegEvidence?:TimelineJpegEvidence;
 /** Exact canonical creative binding identity, including strength and profile. */
 readonly lookCacheKey?:string|null;
}
export const TIMELINE_IMAGE_LAYER_LIMITS=Object.freeze({layers:100,sourceBytes:32*1024*1024,sourcePixels:2073600,
 outputPixels:2073600,totalOutputPixels:32_000_000,fileBytes:9*1024*1024,totalBytes:128*1024*1024,deriveTimeoutMs:20000});
const fault=(budget=false)=>Object.assign(new Error(budget?'The static image layers exceed the bounded render staging budget.':'The image display transform or derived static layer staging cannot be verified.'),{code:budget?'TIMELINE_COLOUR_LUT_BUDGET':'TIMELINE_COLOUR_RESOURCE_CHANGED'});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
interface Identity {readonly dev:number;readonly ino:number;readonly bytes:number;readonly sha256:string}
interface VerifiedFile extends Identity {readonly file:string;readonly maximum:number}
const validPath=(value:unknown):value is string=>typeof value==='string'&&path.isAbsolute(value)&&value.length<=4096&&!/[\0\r\n]/u.test(value);

// Never read a stat-sized unbounded file. The fixed buffer and explicit byte
// ceiling also bound a concurrently growing file. Owned staging separately
// fences path/inode/mode identity before and after every asynchronous effect.
function inspect(file:string,maximum:number,expected?:Identity,png?:{width:number;height:number}):Identity {
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const info=fstatSync(fd);
  if(!info.isFile()||info.nlink!==1||info.size<1||info.size>maximum||expected&&(info.dev!==expected.dev||info.ino!==expected.ino||info.size!==expected.bytes))throw fault();
  const hash=createHash('sha256'),buffer=Buffer.alloc(Math.min(65536,maximum+1));let offset=0;
  while(true){const count=readSync(fd,buffer,0,Math.min(buffer.length,maximum+1-offset),offset);if(count===0)break;offset+=count;if(offset>maximum)throw fault();hash.update(buffer.subarray(0,count));}
  const final=fstatSync(fd),sha256=hash.digest('hex');
  if(offset!==info.size||final.dev!==info.dev||final.ino!==info.ino||final.nlink!==info.nlink||final.size!==info.size||final.mtimeMs!==info.mtimeMs||final.ctimeMs!==info.ctimeMs||expected&&sha256!==expected.sha256)throw fault();
  if(png){
   const header=Buffer.alloc(33),tail=Buffer.alloc(12);if(readSync(fd,header,0,33,0)!==33||readSync(fd,tail,0,12,info.size-12)!==12||
    !header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||header.readUInt32BE(8)!==13||header.toString('ascii',12,16)!=='IHDR'||
    header.readUInt32BE(16)!==png.width||header.readUInt32BE(20)!==png.height||header[24]!==8||header[25]!==6||header[26]!==0||header[27]!==0||header[28]!==0||
    !tail.equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130])))throw fault();
  }
  return {dev:info.dev,ino:info.ino,bytes:offset,sha256};
 } finally {closeSync(fd);}
}
function verify(file:VerifiedFile):void {inspect(file.file,file.maximum,file);}

/** The built-in table is trusted code, never an external 1D LUT admission. */
export async function prepareTimelineImageDisplay(destination:string,options:Options,runtime:StagingRuntime) {
 const owned=createTimelineFloatStaging(destination,options,runtime),table=timelineImageDisplayTable(),file=path.join(owned.work,`display-${table.sha256}.cube`);let recorded:VerifiedFile|undefined;
 const verifyBytes=()=>{owned.effect();if(!recorded)throw fault();verify(recorded);owned.effect();};
 try {await owned.writeOwnedFile(file,table.text);owned.effect();recorded={file,maximum:table.bytes,...inspect(file,table.bytes)};
  if(recorded.sha256!==table.sha256||recorded.bytes!==table.bytes)throw fault();verifyBytes();return {file,effect:owned.effect,verifyBytes,cleanup:owned.cleanup};}
 catch(error){owned.cleanup();throw error;}
}

/** Evaluate each static source/look/rect once per render attempt, never per
 * timeline frame. The PNG is an internal lossless container of the exact
 * PREMULTIPLIED encoded RGBA8 graph result, not an ordinary straight-alpha
 * image resource and not a persistent proxy cache. Loop/decode it as RGBA and
 * overlay with alpha=premultiplied; do not apply colour conversion again.
 *
 * Parent supplies already admitted source descriptors and canonical LUT paths.
 * We additionally bind their current bytes/inodes during derivation. On an
 * unconfirmed child termination no staging is removed until the child joins.
 */
export async function prepareTimelineImageLayers(inputs:readonly TimelineImageLayerInput[],destination:string,options:Options,runtime:LayerRuntime):Promise<{
 path(clipId:string):string|undefined;effect():void;verifyBytes():void;cleanup():boolean;readonly totalBytes:number;readonly totalPixels:number;
}> {
 runtime.checkMediaEffect(options.beforeEffect,options.signal);
 if(!Array.isArray(inputs)||inputs.length>TIMELINE_IMAGE_LAYER_LIMITS.layers)throw fault(true);
 const descriptors=inputs.map(item=>({...item})),ids=new Set<string>();
 for(const item of descriptors){
  if(!item||typeof item.clipId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/u.test(item.clipId)||ids.has(item.clipId)||!validPath(item.sourcePath)||
   !/^[a-f0-9]{64}$/u.test(item.assetSha256)||!Number.isSafeInteger(item.width)||!Number.isSafeInteger(item.height)||item.width<1||item.height<1||item.width>4096||item.height>4096||item.width*item.height>TIMELINE_IMAGE_LAYER_LIMITS.outputPixels||
   !Number.isSafeInteger(item.sourceWidth)||!Number.isSafeInteger(item.sourceHeight)||item.sourceWidth<1||item.sourceHeight<1||item.sourceWidth>4096||item.sourceHeight>4096||item.sourceWidth*item.sourceHeight>TIMELINE_IMAGE_LAYER_LIMITS.sourcePixels||
   (item.creativeLutPath===undefined?item.lookCacheKey!=null:!validPath(item.creativeLutPath)||typeof item.lookCacheKey!=='string'||item.lookCacheKey.length<1||item.lookCacheKey.length>2048)||
   item.crop!==undefined&&(!item.crop||![item.crop.x,item.crop.y].every(value=>Number.isSafeInteger(value)&&value>=0)||![item.crop.width,item.crop.height].every(value=>Number.isSafeInteger(value)&&value>=1)||
    item.crop.x+item.crop.width>item.sourceWidth||item.crop.y+item.crop.height>item.sourceHeight))throw fault();
  if(item.jpegEvidence){jpegDecodeIdentity(item.jpegEvidence);if(item.jpegEvidence.sha256!==item.assetSha256||item.jpegEvidence.width!==item.sourceWidth||item.jpegEvidence.height!==item.sourceHeight)throw fault();}
  ids.add(item.clipId);
 }
 if(!inputs.length)return {path:()=>undefined,effect:()=>runtime.checkMediaEffect(options.beforeEffect,options.signal),verifyBytes:()=>runtime.checkMediaEffect(options.beforeEffect,options.signal),cleanup:()=>true,totalBytes:0,totalPixels:0};
 const owned=createTimelineFloatStaging(destination,options,runtime),table=timelineImageDisplayTable(),tablePath=path.join(owned.work,`display-${table.sha256}.cube`);
 const verified:VerifiedFile[]=[],files=new Map<string,string>(),byClip=new Map<string,string>();let totalBytes=table.bytes,totalPixels=0;
 let activeSource:VerifiedFile|undefined,activeLook:VerifiedFile|undefined;
 const verifyBytes=()=>{owned.effect();for(const file of verified)verify(file);if(activeSource)verify(activeSource);if(activeLook)verify(activeLook);owned.effect();};
 try {
  await owned.writeOwnedFile(tablePath,table.text);owned.effect();const fixed=inspect(tablePath,table.bytes);
  if(fixed.sha256!==table.sha256||fixed.bytes!==table.bytes)throw fault();verified.push({file:tablePath,maximum:table.bytes,...fixed});verifyBytes();
  for(const item of descriptors){
   verifyBytes();activeSource={file:item.sourcePath,maximum:TIMELINE_IMAGE_LAYER_LIMITS.sourceBytes,...inspect(item.sourcePath,TIMELINE_IMAGE_LAYER_LIMITS.sourceBytes)};
   if(activeSource.sha256!==item.assetSha256)throw fault();
   activeLook=item.creativeLutPath===undefined?undefined:{file:item.creativeLutPath,maximum:21*1024*1024,...inspect(item.creativeLutPath,21*1024*1024)};
   const identity=['static-image-evaluation-v1',item.assetSha256,'png-rgb8-srgb-v1',TIMELINE_IMAGE_DISPLAY_PROFILE_ID,TIMELINE_IMAGE_DISPLAY_TABLE_SHA256,
    TIMELINE_IMAGE_RESIZE_PROFILE_ID,'straight-source-premultiplied-rgba8-output',item.sourceWidth,item.sourceHeight,item.width,item.height,item.lookCacheKey??null,activeLook?.sha256??null,
    // Uncropped layers keep their historical identity.
    ...(item.crop?['crop',item.crop.x,item.crop.y,item.crop.width,item.crop.height]:[])];
   const jpegIdentity=item.jpegEvidence?[...identity]:null;
   if(jpegIdentity){jpegIdentity[0]='static-jfif-evaluation-v1';jpegIdentity[2]=item.jpegEvidence!.profileId;}
   const key=digest(JSON.stringify(jpegIdentity?[...jpegIdentity,...jpegDecodeIdentity(item.jpegEvidence!)]:identity));
   let file=files.get(key);
   if(file===undefined){
    const pixels=item.width*item.height;if(pixels>TIMELINE_IMAGE_LAYER_LIMITS.totalOutputPixels-totalPixels||totalBytes>TIMELINE_IMAGE_LAYER_LIMITS.totalBytes-TIMELINE_IMAGE_LAYER_LIMITS.fileBytes)throw fault(true);
    file=path.join(owned.work,`image-${String(files.size).padStart(3,'0')}-${key}.png`);owned.reserve(file);verifyBytes();
    const filters=timelineImageFilterGraph({input:item.jpegEvidence?'jpeg_rgb':'0:v:0',label:'layer',sourceWidth:item.sourceWidth,sourceHeight:item.sourceHeight,width:item.width,height:item.height,...(item.crop?{crop:item.crop}:{}),displayTablePath:tablePath,creativeLutPath:item.creativeLutPath});
    if(item.jpegEvidence)filters.unshift(`[0:v:0]${JFIF_RGB24_FILTER}[jpeg_rgb]`);
    await runtime.run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1','-filter_complex_threads','1',...(item.jpegEvidence?JFIF_INPUT_ARGS:[]),'-noautorotate','-i',item.sourcePath,
     '-filter_complex',filters.join(';'),'-map','[layer]','-frames:v','1','-an','-threads','1','-c:v','png','-pix_fmt','rgba','-compression_level','1','-map_metadata','-1',
     '-fs',String(TIMELINE_IMAGE_LAYER_LIMITS.fileBytes),'-f','image2','-update','1',file],{timeout:TIMELINE_IMAGE_LAYER_LIMITS.deriveTimeoutMs,maxStdoutBytes:0,maxStderrBytes:65536,signal:options.signal,beforeEffect:verifyBytes});
    verifyBytes();const recorded=inspect(file,TIMELINE_IMAGE_LAYER_LIMITS.fileBytes,undefined,{width:item.width,height:item.height});
    if(recorded.bytes>TIMELINE_IMAGE_LAYER_LIMITS.totalBytes-totalBytes)throw fault(true);
    verified.push({file,maximum:TIMELINE_IMAGE_LAYER_LIMITS.fileBytes,...recorded});files.set(key,file);totalBytes+=recorded.bytes;totalPixels+=pixels;verifyBytes();
   }
   byClip.set(item.clipId,file);activeSource=undefined;activeLook=undefined;verifyBytes();
  }
  verifyBytes();return {path:clipId=>byClip.get(clipId),effect:verifyBytes,verifyBytes,cleanup:owned.cleanup,totalBytes,totalPixels};
 }catch(error){
  if(error!==null&&typeof error==='object'&&'terminationUnconfirmed' in error&&error.terminationUnconfirmed===true){
   // The rejected factory has no returned stage for the parent to retain. Keep
   // these exact descriptors alive here, and never delete on an uncertain join.
   void runtime.waitForMediaProcesses({signal:options.signal}).then(()=>{owned.cleanup();}).catch(()=>{});
  }else owned.cleanup();
  throw error;
 }
}
