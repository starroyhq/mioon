import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {types} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import {inspectStaticSrgbPng} from './timeline-image-admission.ts';
import {timelineColourSourceInspectInputSchema, timelineImageSourceInspectResponseSchema, timelineImageEvidenceSchema, timelineImageSourceSchema} from '../../contracts/src/timeline-colour.ts';
import type {TimelineImageEvidence, TimelineImageSourceInspection} from '../../contracts/src/timeline-colour.ts';

const LIMIT=32*1024*1024;
const fault=(code:string,status=409):Error&{code:string;status:number}=>Object.assign(new Error(
 code==='TIMELINE_COLOUR_SOURCE_UNSUPPORTED'?'This image needs a supported static RGB8/RGBA8 PNG with sRGB or untagged colour. ICC, HDR, animation and other metadata are not silently discarded.':
 code==='TIMELINE_COLOUR_SOURCE_MISMATCH'?'The saved image interpretation no longer matches the verified PNG bytes. Inspect and confirm the source again.':
 code==='TIMELINE_COLOUR_SOURCE_BUSY'?'Another image colour inspection is still running.':
 'The owned PNG source cannot be verified safely.'),{code,status});
interface Asset {id:string;projectId:string;sha256:string;sizeBytes:number;mimeType:string;relativePath:string}
interface Identity {dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}
export interface TimelineImageFileRuntime {validateSource(root:string,asset:Asset,options:{maxBytes:number}):{file:string;info:Identity}}
const sameManagedFile=(left:Identity,right:Identity):boolean=>['dev','ino','size','mtimeMs','ctimeMs'].every(key=>left[key as keyof Identity]===right[key as keyof Identity]);
interface ReadOptions {signal?:AbortSignal;beforeEffect?:()=>void;expected?:Identity}
const check=(options:ReadOptions):void=>{options.beforeEffect?.();if(options.signal?.aborted)throw fault('OPERATION_CANCELLED',503);};

/** One bounded no-follow read of the hash-owned PNG. No imported filename,
 * tag or metadata value becomes a path or decoder argument. Stat fences retain
 * the established managed-media trust boundary, not an OS parser sandbox. */
export async function readManagedTimelineImage(root:string,asset:Asset,options:ReadOptions,runtime:TimelineImageFileRuntime):Promise<{evidence:TimelineImageEvidence;info:Identity;file:string}> {
 check(options);
 if(asset.mimeType!=='image/png'||!Number.isSafeInteger(asset.sizeBytes)||asset.sizeBytes<1||asset.sizeBytes>LIMIT)throw fault('TIMELINE_COLOUR_SOURCE_UNSUPPORTED',413);
 const source=runtime.validateSource(root,asset,{maxBytes:LIMIT});
 if(options.expected&&!sameManagedFile(source.info,options.expected))throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
 const fence=()=>{check(options);const current=runtime.validateSource(root,asset,{maxBytes:LIMIT});if(current.file!==source.file||!sameManagedFile(current.info,source.info))throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');};
 const handle=await open(source.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  fence();const initial=await handle.stat();fence();
  if(!initial.isFile()||initial.nlink!==1||initial.size!==asset.sizeBytes||!sameManagedFile(source.info,initial))throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
  const bytes=Buffer.alloc(initial.size);let position=0;
  while(position<bytes.length){
   fence();const read=await handle.read(bytes,position,Math.min(65536,bytes.length-position),position);fence();
   if(read.bytesRead<1)throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');position+=read.bytesRead;
  }
  const after=await handle.stat();fence();if(!sameManagedFile(initial,after))throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
  let inspected;
  try{inspected=await inspectStaticSrgbPng(bytes,{signal:options.signal,beforeEffect:fence});}
  catch(error){if(error&&typeof error==='object'&&'code'in error&&['unsupported_png','corrupt_png','png_budget_exceeded','invalid_png_input'].includes(String(error.code)))throw fault('TIMELINE_COLOUR_SOURCE_UNSUPPORTED');throw error;}
  fence();
  // Admission's status is not stored as file evidence. The colour tag itself
  // determines whether an explicit user interpretation is required.
  const evidence=timelineImageEvidenceSchema.parse({profileId:inspected.profileId,sha256:inspected.sha256,sourceByteLength:inspected.sourceByteLength,
   width:inspected.width,height:inspected.height,bitDepth:inspected.bitDepth,alphaMode:inspected.alphaMode,orientation:inspected.orientation,colourTag:inspected.colourTag});
  if(evidence.sha256!==asset.sha256||evidence.sourceByteLength!==asset.sizeBytes)throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
  return {evidence,info:source.info,file:source.file};
 }finally{await handle.close();}
}

export function validateTimelineImageSourceInterpretation({source,evidence,assetSha256,probe,streamIndex}:{source:unknown;evidence:unknown;assetSha256:string;probe:unknown;streamIndex:number|undefined}):TimelineImageEvidence {
 const declaration=timelineImageSourceSchema.safeParse(source),actual=timelineImageEvidenceSchema.safeParse(evidence);
 if(!declaration.success||!actual.success||declaration.data.assetSha256!==assetSha256||actual.data.sha256!==assetSha256||
  JSON.stringify(declaration.data.evidence)!==JSON.stringify(actual.data)||streamIndex!==0)throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
 const object=probe as {streams?:Array<{index?:unknown;codec_type?:unknown;codec_name?:unknown;pix_fmt?:unknown;width?:unknown;height?:unknown;sample_aspect_ratio?:unknown}>};
 const stream=object?.streams?.find(value=>value.index===streamIndex);
 if(!stream||object.streams?.length!==1||stream.codec_type!=='video'||stream.codec_name!=='png'||
  stream.pix_fmt!==(actual.data.alphaMode==='straight'?'rgba':'rgb24')||stream.width!==actual.data.width||stream.height!==actual.data.height||
  stream.sample_aspect_ratio!==undefined&&!['1:1','N/A','0:1'].includes(String(stream.sample_aspect_ratio)))throw fault('TIMELINE_COLOUR_SOURCE_UNSUPPORTED');
 return actual.data;
}
interface Runtime extends TimelineImageFileRuntime {assertOrdinaryWorkspace():void;ownsLock():boolean;readOwnedAsset(projectId:string,assetId:string):unknown}
interface Active {controller:AbortController;task:Promise<unknown>}
const states=new WeakMap<DatabaseSync,{active:Active|null;stopped:boolean}>();
export function createTimelineImageSourceServices(store:{db:DatabaseSync;root:string},{runtime,signal:ownerSignal}:{runtime:Runtime;signal?:AbortSignal}) {
 let state=states.get(store.db);if(!state){state={active:null,stopped:false};states.set(store.db,state);}const owner=state;
 const available=(signal?:AbortSignal)=>{runtime.assertOrdinaryWorkspace();if(!runtime.ownsLock())throw fault('TIMELINE_COLOUR_SOURCE_OWNER_REQUIRED',403);
  if(owner.stopped||ownerSignal?.aborted||signal?.aborted)throw fault('OPERATION_CANCELLED',503);if(store.db.isTransaction)throw fault('TIMELINE_COLOUR_SOURCE_UNAVAILABLE');};
 const stop=()=>{owner.stopped=true;owner.active?.controller.abort();};ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
 function current(projectId:string,assetId:string):Asset {
  available();const asset=runtime.readOwnedAsset(projectId,assetId) as Asset|undefined;
  if(!asset||asset.projectId!==projectId||asset.id!==assetId||asset.mimeType!=='image/png'||typeof asset.relativePath!=='string'||
   !/^[a-f0-9]{64}$/u.test(asset.sha256)||!Number.isSafeInteger(asset.sizeBytes))throw fault('TIMELINE_COLOUR_SOURCE_UNSUPPORTED');
  return {id:asset.id,projectId:asset.projectId,sha256:asset.sha256,sizeBytes:asset.sizeBytes,mimeType:asset.mimeType,relativePath:asset.relativePath};
 }
 async function inspect(raw:unknown,context:{signal?:AbortSignal}={}):Promise<TimelineImageSourceInspection> {
  available(context.signal);
  if(raw===null||typeof raw!=='object'||types.isProxy(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))throw fault('VALIDATION_ERROR',400);
  for(const key of Reflect.ownKeys(raw)){const d=Object.getOwnPropertyDescriptor(raw,key);if(typeof key!=='string'||!d?.enumerable||!Object.hasOwn(d,'value'))throw fault('VALIDATION_ERROR',400);}
  const parsed=timelineColourSourceInspectInputSchema.safeParse(raw);if(!parsed.success)throw fault('VALIDATION_ERROR',400);
  if(owner.active)throw fault('TIMELINE_COLOUR_SOURCE_BUSY',429);
  const input=parsed.data,asset=current(input.projectId,input.assetId),identity=JSON.stringify(asset),controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,ownerSignal,context.signal].filter((value):value is AbortSignal=>Boolean(value)));
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},15000);
  const fence=()=>{available(signal);if(JSON.stringify(current(input.projectId,input.assetId))!==identity)throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');};
  const entry:Active={controller,task:Promise.resolve()};owner.active=entry;
  entry.task=(async()=>{try{
   const {evidence}=await readManagedTimelineImage(store.root,asset,{signal,beforeEffect:fence},runtime);fence();
   return timelineImageSourceInspectResponseSchema.parse({...input,assetSha256:asset.sha256,kind:'image',evidence,status:evidence.colourTag==='srgb'?'compatible':'needs_interpretation'});
  }catch(error){if(timedOut)throw fault('TIMELINE_COLOUR_SOURCE_TIMEOUT',503);throw error;}
  finally{clearTimeout(timer);if(owner.active===entry)owner.active=null;}})();
  return await entry.task as TimelineImageSourceInspection;
 }
 async function drain():Promise<void>{stop();try{if(owner.active)await Promise.allSettled([owner.active.task]);}finally{ownerSignal?.removeEventListener('abort',stop);}}
 return {handlers:{'timeline.colour.image.inspect':inspect},drain};
}
