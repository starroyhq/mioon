import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import path from 'node:path';
import {LUT_RESOURCE_LIMITS,LUT_RESOURCE_PROFILE} from '../../contracts/src/lut-resources.ts';
import {readLutResource,parseLutBytes,lutHash} from './lut-resource-validation.ts';
import {parseCube3D,sampleCube3D} from './cube-lut.ts';
import {createTimelineFloatStaging} from './timeline-float-staging.ts';

export const TIMELINE_COLOUR_LUT_LIMITS=Object.freeze({canonicalBytes:21*1024*1024,totalCanonicalBytes:128*1024*1024,files:100});
export const TIMELINE_COLOUR_LUT_ALGORITHM='cube3d-tetrahedral-premixed-v1';
export interface ColourLutBinding {resourceId:string;resourceSha256:string;resourceProfile:string;enabled:boolean;strength:number}
interface ColourPlan {clips:ReadonlyArray<{clipId:string;look:ColourLutBinding|null}>}
export interface ColourLutContent {bytes:Uint8Array;sha256:string;profile:string}
export type ColourLutReader=(binding:ColourLutBinding,verifyBytes?:boolean)=>ColourLutContent|undefined;
const invalid=(code='TIMELINE_COLOUR_RESOURCE_CHANGED'):Error=>Object.assign(new Error(code==='TIMELINE_COLOUR_LUT_BUDGET'?'The saved creative looks exceed the bounded render staging budget. Reduce distinct looks or strengths.':'The frozen project LUT resource or its private render copy could not be verified.'),{code});
const digest=(bytes:Uint8Array|string):string=>createHash('sha256').update(bytes).digest('hex');
const used=(binding:ColourLutBinding|null):binding is ColourLutBinding=>Boolean(binding?.enabled&&binding.strength>0);
export function verifyTimelineColourLuts(plan:ColourPlan,read:ColourLutReader|undefined,verifyBytes=true):void {
 const seen=new Set<string>();
 for(const item of plan.clips)if(used(item.look)&&!seen.has(item.look.resourceId)){
  if(!read)throw invalid();read(item.look,verifyBytes);seen.add(item.look.resourceId);
 }
}

/** A caller's stable project is captured, never accepted from a LUT name/path. */
export function createTimelineColourLutReader(db:DatabaseSync,projectId:string):ColourLutReader {
 return (binding,verifyBytes=true)=>{
  const resource=readLutResource(db,projectId,binding.resourceId,false);
  if(resource.sha256!==binding.resourceSha256||resource.profile!==binding.resourceProfile||resource.profile!==LUT_RESOURCE_PROFILE)throw invalid();
  if(!verifyBytes)return undefined;
  const cell=db.prepare(`SELECT CASE WHEN typeof(content)='blob' AND length(content) BETWEEN 1 AND ${LUT_RESOURCE_LIMITS.sourceBytes} THEN content END AS content FROM main.project_lut_resources WHERE projectId=? AND id=?`).get(projectId,binding.resourceId);
  if(!(cell?.content instanceof Uint8Array))throw invalid();
  const bytes=Buffer.from(cell.content);
  if(bytes.length!==resource.sizeBytes||lutHash(bytes)!==resource.sha256)throw invalid();
  const parsed=parseLutBytes(bytes);
  if(JSON.stringify(parsed.metadata)!==JSON.stringify(resource.metadata))throw invalid();
  return {bytes,sha256:resource.sha256,profile:resource.profile};
 };
}

/** Deterministic normalized-domain vertex premix; source bytes remain immutable.
 * Algorithm validated independently against TS tetrahedral sampling and FFmpeg.
 * Title/comments never reach filter grammar. Positive strength only: 0 bypasses.
 */
export function premixTimelineColourLut(content:ColourLutContent,strength:number):{text:string;sha256:string;bytes:number} {
 if(!(content.bytes instanceof Uint8Array)||content.bytes.length<1||content.bytes.length>LUT_RESOURCE_LIMITS.sourceBytes||content.profile!==LUT_RESOURCE_PROFILE||digest(content.bytes)!==content.sha256||!Number.isFinite(strength)||strength<=0||strength>1)throw invalid();
 const cube=parseLutBytes(Buffer.from(content.bytes)),size=cube.metadata.size;
 const lines=[`LUT_3D_SIZE ${size}`,'DOMAIN_MIN 0 0 0','DOMAIN_MAX 1 1 1'];
 let bytes=lines.reduce((sum,line)=>sum+line.length+1,0);
 for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++){
  const row=sampleCube3D(cube,[r/(size-1),g/(size-1),b/(size-1)],strength).map(value=>String(value===0?0:value));
  if(row.some(value=>value.length>24))throw invalid();
  const line=row.join(' ');bytes+=line.length+1;
  if(bytes>TIMELINE_COLOUR_LUT_LIMITS.canonicalBytes)throw invalid('TIMELINE_COLOUR_LUT_BUDGET');
  lines.push(line);
 }
 const text=lines.join('\n')+'\n';parseCube3D(text);
 return {text,sha256:digest(text),bytes};
}

// Option-value escaping followed by filtergraph escaping; no shell involved.
export function timelineColourFilterPath(file:string):string {
 if(!path.isAbsolute(file)||/[\r\n\0]/u.test(file))throw invalid();
 return file.replace(/[\\':]/gu,value=>'\\'+value).replace(/[\\',;\[\]]/gu,value=>'\\'+value);
}
export const timelineColourInputFilter=(range:'limited'|'full'):string=>{
 if(range!=='limited'&&range!=='full')throw invalid('INVALID_TIMELINE_COLOUR');
 return `zscale=matrixin=709:transferin=709:primariesin=709:rangein=${range}:matrix=gbr:transfer=709:primaries=709:range=full:dither=none,format=gbrpf32le`;
};
export const TIMELINE_COLOUR_OUTPUT_FILTER='format=gbrpf32le,zscale=matrixin=gbr:transferin=709:primariesin=709:rangein=full:matrix=709:transfer=709:primaries=709:range=limited:dither=none,format=yuv420p';
export const TIMELINE_COLOUR_OUTPUT_ARGS=Object.freeze(['-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv']);

type StagingRuntime=Parameters<typeof createTimelineFloatStaging>[2];
interface StageOptions {signal?:AbortSignal;beforeEffect?:()=>void;readLut?:ColourLutReader}
/** Separate owned flat set avoids weakening historical segment staging caps.
 * It is kept alive until the renderer has joined every exact media child.
 */
export async function prepareTimelineColourLuts(plan:ColourPlan,destination:string,options:StageOptions,runtime:StagingRuntime):Promise<{
 filter(clipId:string):string;path(clipId:string):string|undefined;effect():void;verifyBytes():void;cleanup():boolean;readonly totalBytes:number;
}> {
 runtime.checkMediaEffect(options.beforeEffect,options.signal);
 const bindings=plan.clips.filter(item=>used(item.look));
 const filters=new Map<string,string>(),paths=new Map<string,string>();
 if(!bindings.length)return {filter:()=>'',path:()=>undefined,effect:()=>runtime.checkMediaEffect(options.beforeEffect,options.signal),verifyBytes:()=>runtime.checkMediaEffect(options.beforeEffect,options.signal),cleanup:()=>true,totalBytes:0};
 if(!options.readLut)throw invalid();
 const read=options.readLut,owned=createTimelineFloatStaging(destination,options,runtime),copies=new Map<string,{file:string;sha256:string;bytes:number}>();
 let totalBytes=0;
 const effect=()=>{owned.effect();verifyTimelineColourLuts(plan,read,false);};
 try {
  for(const item of bindings){
   effect();const binding=item.look!,key=JSON.stringify([binding.resourceSha256,binding.resourceProfile,TIMELINE_COLOUR_LUT_ALGORITHM,binding.strength]);
   let copy=copies.get(key);
   if(!copy){
    if(copies.size>=TIMELINE_COLOUR_LUT_LIMITS.files)throw invalid('TIMELINE_COLOUR_LUT_BUDGET');
    const content=read(binding,true);if(!content)throw invalid();
    const canonical=premixTimelineColourLut(content,binding.strength);effect();
    if(canonical.bytes>TIMELINE_COLOUR_LUT_LIMITS.totalCanonicalBytes-totalBytes)throw invalid('TIMELINE_COLOUR_LUT_BUDGET');
    const file=path.join(owned.work,`look-${String(copies.size).padStart(3,'0')}-${canonical.sha256}.cube`);
    await owned.writeOwnedFile(file,canonical.text);effect();
    copy={file,sha256:canonical.sha256,bytes:canonical.bytes};copies.set(key,copy);totalBytes+=copy.bytes;
   }
   // copy forces independently allocated float planes before lut3d. This is a
   // proved workaround for the observed supported-FFmpeg raw-plane boundary case.
   paths.set(item.clipId,copy.file);
   filters.set(item.clipId,`copy,lut3d=file=${timelineColourFilterPath(copy.file)}:interp=tetrahedral,`);
  }
  const verifyBytes=()=>{
   effect();const checked=new Set<string>();
   for(const item of bindings){const key=item.look!.resourceId;if(!checked.has(key)){read(item.look!,true);checked.add(key);}}
   for(const copy of copies.values()){
    effect();const fd=openSync(copy.file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size!==copy.bytes||digest(readFileSync(fd))!==copy.sha256)throw invalid();}
    finally{closeSync(fd);}effect();
   }
  };
  verifyBytes();return {filter:clipId=>filters.get(clipId)??'',path:clipId=>paths.get(clipId),effect,verifyBytes,cleanup:owned.cleanup,totalBytes};
 }catch(error){owned.cleanup();throw error;}
}
