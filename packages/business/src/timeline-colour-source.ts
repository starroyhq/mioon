import {types} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import {timelineClipColourSchema, timelineColourSourceInspectInputSchema, timelineColourSourceInspectResponseSchema,timelineColourPixelBitDepth,timelineColourSourceEvidenceStatus} from '../../contracts/src/timeline-colour.ts';
import type {TimelineColourSourceEvidence, TimelineColourSourceInspection} from '../../contracts/src/timeline-colour.ts';

/** Observation budgets only. These limits never alter ordinary legacy imports. */
export const TIMELINE_COLOUR_SOURCE_LIMITS = Object.freeze({sourceBytes:512*1024*1024, hashBytes:1024*1024*1024,
  timeoutMs:60000, probeTimeoutMs:10000, probeBytes:128*1024, stderrBytes:64*1024, streams:256} as const);
const LIMITS=TIMELINE_COLOUR_SOURCE_LIMITS;
const fault=(code:string,status=409):Error&{code:string;status:number}=>Object.assign(new Error(
  code==='TIMELINE_COLOUR_SOURCE_UNSUPPORTED'?'This source is not supported by the Rec.709 SDR colour profile. HDR, Log, non-709, RGB and alpha sources need a different colour workflow.':
  code==='TIMELINE_COLOUR_SOURCE_MISMATCH'?'The saved source interpretation no longer matches the actual source bytes, stream or range. Inspect and confirm the source again.':
  code==='TIMELINE_COLOUR_SOURCE_BUSY'?'Another source colour inspection is still running.':
  'The owned source colour evidence cannot be verified. Inspect the source again.'),{code,status});
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function unavailable():never {throw fault('TIMELINE_COLOUR_SOURCE_UNAVAILABLE',404);}
function invalidProbe():never {throw fault('TIMELINE_COLOUR_SOURCE_INVALID_PROBE');}
const unknownTags=new Set(['','unknown','unspecified','reserved','n/a','none']);
function tag(value:unknown):string|null {
  if(value===undefined||value===null)return null;
  if(typeof value!=='string'||value.length>80)invalidProbe();
  const normalized=value.trim().toLowerCase();return unknownTags.has(normalized)?null:normalized;
}
function streams(probe:unknown):Record<string,unknown>[] {
  if(!object(probe)||!Array.isArray(probe.streams)||probe.streams.length>LIMITS.streams||probe.streams.some(s=>!object(s)))invalidProbe();
  const seen=new Set<number>();
  for(const stream of probe.streams){
    if(!Number.isSafeInteger(stream.index)||stream.index<0||seen.has(stream.index))invalidProbe();
    seen.add(stream.index);
  }
  return probe.streams;
}
const playable=(stream:Record<string,unknown>):boolean=>stream.codec_type==='video'&&typeof stream.codec_name==='string'&&
  stream.codec_name.length>0&&stream.codec_name!=='unknown'&&!((object(stream.disposition)&&stream.disposition.attached_pic))&&
  typeof stream.width==='number'&&Number.isSafeInteger(stream.width)&&stream.width>0&&stream.width<=16384&&
  typeof stream.height==='number'&&Number.isSafeInteger(stream.height)&&stream.height>0&&stream.height<=16384&&stream.width*stream.height<=64*1024*1024;
function selectedStream(probe:unknown,streamIndex?:number):Record<string,unknown>|null {
  const all=streams(probe);
  if(streamIndex!==undefined&&(!Number.isSafeInteger(streamIndex)||streamIndex<0))invalidProbe();
  return all.find(stream=>playable(stream)&&(streamIndex===undefined||stream.index===streamIndex))??null;
}
export function timelineColourSourceStreamIndex(probe:unknown):number|null {
  const stream=selectedStream(probe);return stream?stream.index as number:null;
}
/** Explicit opaque YUV layouts supported by this first encoded-RGB SDR lane.
 * RGB, gray and alpha are deliberately absent; an unknown layout is not a guess. */
const pixelDepth=timelineColourPixelBitDepth;
function hasHdrSideData(value:unknown):boolean {
  if(value===undefined)return false;
  if(!Array.isArray(value)||value.length>256)invalidProbe();
  return value.some(entry=>{
    if(!object(entry)||typeof entry.side_data_type!=='string'||entry.side_data_type.length>200)invalidProbe();
    return /hdr|mastering.display|content.light|dovi|dolby.vision|ambient.viewing.environment/iu.test(entry.side_data_type);
  });
}
export function deriveTimelineColourSourceEvidence(probe:unknown,streamIndex?:number):TimelineColourSourceEvidence {
  const stream=selectedStream(probe,streamIndex);
  if(!stream)return {primaries:null,transfer:null,matrix:null,range:null,pixelFormat:null,bitDepth:null,hdrMetadata:false};
  const format=tag(stream.pix_fmt),impliedDepth=pixelDepth(format);
  const supplied=[stream.bits_per_raw_sample,stream.bits_per_sample].find(value=>value!==undefined&&value!==null&&value!==''&&value!=='0'&&value!==0);
  let bitDepth=impliedDepth;
  if(supplied!==undefined){
    if(!['string','number'].includes(typeof supplied)||!/^\d{1,2}$/u.test(String(supplied)))invalidProbe();
    const value=Number(supplied);if(value<1||value>64)invalidProbe();bitDepth=value;
  }
  const range=tag(stream.color_range);
  let hdrMetadata=hasHdrSideData(stream.side_data_list);
  // A caller may additionally supply bounded frame evidence. Never treat a
  // user's declaration or a stored DTO as metadata evidence.
  if(object(probe)&&probe.frames!==undefined){
    if(!Array.isArray(probe.frames)||probe.frames.length>256)invalidProbe();
    for(const frame of probe.frames){if(!object(frame))invalidProbe();if(frame.stream_index===stream.index)hdrMetadata=hasHdrSideData(frame.side_data_list)||hdrMetadata;}
  }
  return {primaries:tag(stream.color_primaries),transfer:tag(stream.color_transfer),matrix:tag(stream.color_space),
    range:range==='tv'?'limited':range==='pc'?'full':range,pixelFormat:format,bitDepth,hdrMetadata};
}
export function classifyTimelineColourSourceEvidence(evidence:TimelineColourSourceEvidence):Pick<TimelineColourSourceInspection,'status'|'reason'> {
  const status=timelineColourSourceEvidenceStatus(evidence);
  if(status==='compatible')return {status,reason:null};
  if(status==='needs_interpretation')return {status,reason:'Colour tags are missing or unspecified. Explicit source interpretation is required.'};
  if(evidence.hdrMetadata)return {status,reason:'HDR or Dolby Vision side data is present.'};
  if(pixelDepth(evidence.pixelFormat)===null||pixelDepth(evidence.pixelFormat)!==evidence.bitDepth||![8,10].includes(evidence.bitDepth??0))
    return {status,reason:'Only supported opaque 8-bit or 10-bit YUV pixel formats with consistent bit depth are accepted.'};
  for(const field of ['primaries','transfer','matrix'] as const){
    if(evidence[field]!==null&&evidence[field]!=='bt709')return {status,reason:`Source ${field} is not Rec.709. Technical Log/HDR conversion is not supported.`};
  }
  return {status,reason:'The source colour range is unsupported or conflicts with its pixel format.'};
}
/** Worker guard: call only with a real probe of SHA-verified source bytes.
 * Missing tags may be explicitly interpreted; conflicting evidence may not. */
export function validateTimelineColourSourceInterpretation({source,probe,assetSha256,streamIndex}:{source:unknown;probe:unknown;assetSha256:string;streamIndex:number|undefined}):TimelineColourSourceEvidence {
  const parsed=timelineClipColourSchema.safeParse({profileId:'mioon-rec709-sdr-clip-v1',source,look:null});
  if(!parsed.success||!parsed.data.source||parsed.data.source.assetSha256!==assetSha256||parsed.data.source.streamIndex!==streamIndex||
      timelineColourSourceStreamIndex(probe)!==streamIndex)throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
  const evidence=deriveTimelineColourSourceEvidence(probe,streamIndex);
  if(classifyTimelineColourSourceEvidence(evidence).status==='unsupported')throw fault('TIMELINE_COLOUR_SOURCE_UNSUPPORTED');
  if(evidence.range!==null&&evidence.range!==parsed.data.source.range)throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
  // The deprecated yuvj formats intrinsically encode full range. Absence of a
  // range tag cannot authorize interpreting them as limited.
  if(evidence.pixelFormat?.startsWith('yuvj')&&parsed.data.source.range!=='full')throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
  return evidence;
}

interface FileIdentity {readonly dev:number;readonly ino:number;readonly size:number;readonly mtimeMs:number;readonly ctimeMs:number}
interface ManagedAsset {readonly id:string;readonly projectId:string;readonly relativePath:string;readonly sha256:string;readonly sizeBytes:number;readonly mimeType:string}
interface HashOptions {signal:AbortSignal;expected:FileIdentity;maxBytes:number;onBytes:(bytes:number)=>void;beforeEffect:()=>void}
export interface TimelineColourSourceRuntime {
  assertOrdinaryWorkspace():void;ownsLock():boolean;
  readOwnedAsset(projectId:string,assetId:string):unknown;
  validateSource(root:string,asset:ManagedAsset,options:{maxBytes:number}):{file:string;info:FileIdentity};
  hash(root:string,asset:ManagedAsset,options:HashOptions):Promise<unknown>;
  probe(file:string,options:{signal:AbortSignal;beforeEffect:()=>void;remainingMs:()=>number}):Promise<unknown>;
  terminate(signal:AbortSignal):Promise<readonly {status:string}[]>;
  waitForClose(signal:AbortSignal):Promise<readonly {status:string}[]>;
  boundedShutdown(work:Promise<unknown>,code:string):Promise<unknown>;
}
interface Active {controller:AbortController;signal:AbortSignal;task:Promise<unknown>}
interface State {active:Active|null;stopped:boolean;shutdownFailure:unknown}
const states=new WeakMap<DatabaseSync,State>();
const sameFile=(a:FileIdentity,b:FileIdentity):boolean=>['dev','ino','size','mtimeMs','ctimeMs'].every(key=>a[key as keyof FileIdentity]===b[key as keyof FileIdentity]);
const fileIdentity=(value:unknown):value is FileIdentity=>object(value)&&['dev','ino','size','mtimeMs','ctimeMs'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key]));
const unconfirmed=(error:unknown):boolean=>object(error)&&error.terminationUnconfirmed===true;
function plainInput(value:unknown):void {
  if(!object(value)||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fault('VALIDATION_ERROR',400);
  const keys=Reflect.ownKeys(value);if(keys.length!==2)throw fault('VALIDATION_ERROR',400);
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!['projectId','assetId'].includes(key)||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string')throw fault('VALIDATION_ERROR',400);}
}
function observe<T>(task:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    let settled=false;const finish=(fn:()=>void):void=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);fn();};
    const abort=():void=>finish(()=>reject(fault('OPERATION_CANCELLED',503)));
    signal.addEventListener('abort',abort,{once:true});task.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));if(signal.aborted)abort();
  });
}
export function createTimelineColourSourceServices(store:{db:DatabaseSync;root:string},options:{runtime:TimelineColourSourceRuntime;signal?:AbortSignal}) {
  const {runtime,signal:ownerSignal}=options;
  let state=states.get(store.db);if(!state){state={active:null,stopped:false,shutdownFailure:null};states.set(store.db,state);}const owner=state;
  const assertOwner=():void=>{runtime.assertOrdinaryWorkspace();if(!runtime.ownsLock())throw fault('TIMELINE_COLOUR_SOURCE_OWNER_REQUIRED',403);};
  const available=(signal?:AbortSignal):void=>{assertOwner();if(owner.shutdownFailure)throw owner.shutdownFailure;if(owner.stopped||ownerSignal?.aborted||signal?.aborted)throw fault('OPERATION_CANCELLED',503);};
  const stop=():void=>{owner.stopped=true;owner.active?.controller.abort();};
  ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
  function current(projectId:string,assetId:string):ManagedAsset {
    assertOwner();const value=runtime.readOwnedAsset(projectId,assetId);assertOwner();
    if(!object(value)||value.id!==assetId||value.projectId!==projectId||typeof value.relativePath!=='string'||value.relativePath.length>4096||
      typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(value.sha256)||!Number.isSafeInteger(value.sizeBytes)||typeof value.sizeBytes!=='number'||value.sizeBytes<1||
      typeof value.mimeType!=='string'||!value.mimeType.startsWith('video/'))unavailable();
    if(value.sizeBytes>LIMITS.sourceBytes)throw fault('TIMELINE_COLOUR_SOURCE_LIMIT',413);
    return Object.freeze({id:assetId,projectId,relativePath:value.relativePath,sha256:value.sha256,sizeBytes:value.sizeBytes,mimeType:value.mimeType});
  }
  async function inspect(rawInput:unknown,context:{signal?:AbortSignal}={}):Promise<TimelineColourSourceInspection> {
    available(context.signal);plainInput(rawInput);const parsed=timelineColourSourceInspectInputSchema.safeParse(rawInput);if(!parsed.success)throw fault('VALIDATION_ERROR',400);
    if(store.db.isTransaction)throw fault('TIMELINE_COLOUR_SOURCE_UNAVAILABLE');
    if(owner.active)throw fault('TIMELINE_COLOUR_SOURCE_BUSY',429);
    const input=parsed.data,initial=current(input.projectId,input.assetId),identity=JSON.stringify(initial),started=performance.now();
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,ownerSignal,context.signal].filter((s):s is AbortSignal=>s!==undefined));
    let expected:{file:string;info:FileIdentity}|undefined,timedOut=false,bytesHashed=0,fencedFailure:unknown;
    const remainingMs=():number=>Math.max(0,LIMITS.timeoutMs-(performance.now()-started));
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},remainingMs());
    const entry:Active={controller,signal,task:Promise.resolve()};owner.active=entry;
    const fence=():void=>{
      try{
        available(signal);if(store.db.isTransaction||JSON.stringify(current(input.projectId,input.assetId))!==identity)throw fault('TIMELINE_COLOUR_SOURCE_STALE');
        if(remainingMs()<=0){timedOut=true;controller.abort();throw fault('TIMELINE_COLOUR_SOURCE_TIMEOUT',503);}
        if(expected){const actual=runtime.validateSource(store.root,initial,{maxBytes:LIMITS.sourceBytes});if(actual.file!==expected.file||!fileIdentity(actual.info)||!sameFile(actual.info,expected.info))throw fault('TIMELINE_COLOUR_SOURCE_STALE');}
      }catch(error){fencedFailure??=error;throw fencedFailure;}
    };
    async function hash():Promise<void> {
      fence();const before=bytesHashed;
      const value=await runtime.hash(store.root,initial,{signal,expected:expected!.info,maxBytes:LIMITS.sourceBytes,beforeEffect:fence,onBytes(bytes){
        fence();if(!Number.isSafeInteger(bytes)||bytes<1||bytesHashed+bytes>LIMITS.hashBytes)throw fault('TIMELINE_COLOUR_SOURCE_LIMIT',413);bytesHashed+=bytes;
      }});fence();
      if(bytesHashed-before!==initial.sizeBytes||!object(value)||value.sha256!==initial.sha256||value.sizeBytes!==initial.sizeBytes||
        value.file!==expected!.file||!fileIdentity(value.info)||!sameFile(value.info,expected!.info))throw fault('TIMELINE_COLOUR_SOURCE_STALE');
    }
    const work=(async()=>{
      fence();const actual=runtime.validateSource(store.root,initial,{maxBytes:LIMITS.sourceBytes});
      if(typeof actual.file!=='string'||!fileIdentity(actual.info)||actual.info.size!==initial.sizeBytes)throw fault('TIMELINE_COLOUR_SOURCE_STALE');
      expected={file:actual.file,info:Object.freeze({dev:actual.info.dev,ino:actual.info.ino,size:actual.info.size,mtimeMs:actual.info.mtimeMs,ctimeMs:actual.info.ctimeMs})};
      await hash();fence();const probe=await runtime.probe(expected.file,{signal,beforeEffect:fence,remainingMs});fence();
      const streamIndex=timelineColourSourceStreamIndex(probe),evidence=deriveTimelineColourSourceEvidence(probe,streamIndex??undefined),classification=classifyTimelineColourSourceEvidence(evidence);
      await hash();fence();
      const response={projectId:input.projectId,assetId:input.assetId,assetSha256:initial.sha256,streamIndex,evidence,...classification};
      if(!timelineColourSourceInspectResponseSchema.safeParse(response).success)invalidProbe();return response as TimelineColourSourceInspection;
    })();
    const joined=(async()=>{
      try{return await work;}catch(error){if(unconfirmed(error))owner.shutdownFailure=error;throw error;}
      finally{
        let closed=false;
        try{
          const results=await runtime.terminate(signal);
          if(results.some(result=>result.status!=='exited')||unconfirmed(owner.shutdownFailure)){
            const error=Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED',503),{terminationUnconfirmed:true});owner.shutdownFailure=error;
            const actual=await runtime.waitForClose(signal);if(actual.some(result=>result.status!=='exited'))throw error;closed=true;throw error;
          }closed=true;
        }catch(error){owner.shutdownFailure=unconfirmed(error)?error:fault('TIMELINE_COLOUR_SOURCE_SHUTDOWN_FAILED',503);throw owner.shutdownFailure;}
        finally{if(closed&&owner.active===entry)owner.active=null;clearTimeout(timer);}
      }
    })();entry.task=joined;joined.catch(()=>{});
    try{const result=await observe(joined,signal);fence();return result;}
    catch(error){
      if(owner.shutdownFailure)throw owner.shutdownFailure;if(timedOut)throw fault('TIMELINE_COLOUR_SOURCE_TIMEOUT',503);
      const cause=fencedFailure??error,code=object(cause)&&typeof cause.code==='string'?cause.code:'';
      if(code==='RESTORE_OPERATION_UNAVAILABLE'||code==='OPERATION_CANCELLED'||code.startsWith('TIMELINE_COLOUR_SOURCE_'))throw cause;
      if(code==='MEDIA_CANCELLED')throw fault('OPERATION_CANCELLED',503);if(code==='MEDIA_TIMEOUT')throw fault('TIMELINE_COLOUR_SOURCE_TIMEOUT',503);
      if(code.startsWith('MANAGED_'))throw fault('TIMELINE_COLOUR_SOURCE_STALE');throw fault('TIMELINE_COLOUR_SOURCE_INVALID_PROBE');
    }finally{controller.abort();}
  }
  async function drain():Promise<void>{stop();try{await runtime.boundedShutdown(Promise.allSettled(owner.active?[owner.active.task]:[]),'TIMELINE_COLOUR_SOURCE_STOP_TIMEOUT');}
    finally{ownerSignal?.removeEventListener('abort',stop);}if(owner.shutdownFailure)throw owner.shutdownFailure;}
  return {handlers:{'timeline.colour.source.inspect':inspect},drain};
}

/** A fixed shell-free file-only ffprobe invocation; no caller-controlled flags. */
export function createTimelineColourSourceProbe(runtime:{run:(command:string,args:string[],options:Record<string,unknown>)=>Promise<unknown>;
  withProbePermit:<T>(signal:AbortSignal|undefined,operation:()=>Promise<T>)=>Promise<T>;checkMediaEffect:(fence:()=>void,signal?:AbortSignal)=>void}) {
  return async (file:string,{signal,beforeEffect,remainingMs}:{signal:AbortSignal;beforeEffect:()=>void;remainingMs:()=>number}):Promise<unknown>=>runtime.withProbePermit(signal,async()=>{
    runtime.checkMediaEffect(beforeEffect,signal);
    const timeout=Math.min(LIMITS.probeTimeoutMs,remainingMs());if(timeout<=0)throw fault('TIMELINE_COLOUR_SOURCE_TIMEOUT',503);
    const output=await runtime.run('ffprobe',['-v','error','-protocol_whitelist','file','-format_whitelist','mov,matroska,webm','-probesize','10485760','-analyzeduration','5000000','-max_alloc','67108864',
      '-show_entries','stream=index,codec_name,codec_type,width,height,pix_fmt,bits_per_raw_sample,bits_per_sample,color_range,color_space,color_transfer,color_primaries:stream_disposition=attached_pic:stream_side_data=side_data_type','-of','json','-i',file],
      {signal,beforeEffect,beforeSpawn:beforeEffect,timeout,maxStdoutBytes:LIMITS.probeBytes,maxStderrBytes:LIMITS.stderrBytes});
    runtime.checkMediaEffect(beforeEffect,signal);if(typeof output!=='string'||Buffer.byteLength(output)>LIMITS.probeBytes)invalidProbe();
    try{return JSON.parse(output);}catch{invalidProbe();}
  });
}
