import {z} from 'zod';
import {timelineCompositionSegments} from './timeline-segments.ts';

/** Disposable saved-timeline sound only. This profile never changes a saved
 * clip, an export profile, a historical receipt, or a source media file. */
export const AUDIO_PREVIEW_PROFILE = 'saved-timeline-audio-f32le-48k-stereo-v1';
export const AUDIO_PREVIEW_LIMITS = Object.freeze({
  fps:30, sampleRate:48000, channels:2, bytesPerSample:4, samplesPerFrame:1600,
  windowFrames:600, tracks:12, clips:100, timelineFrames:18000,
  sourceBytes:512*1024*1024, sourceSeconds:600, hashReadBytes:1024*1024*1024,
  decodeWorkFrames:18000, totalDecodeSegments:200,
  memoryBytes:96*1024*1024, transportReserveBytes:2*1024*1024,
  prepareTimeoutMs:120000, planBytes:256*1024,
} as const);

const id=z.string().uuid(), digest=z.string().regex(/^[a-f0-9]{64}$/u);
const integer=(max:number,min=0):z.ZodNumber=>z.number().finite().int().min(min).max(max);
const frame=integer(AUDIO_PREVIEW_LIMITS.timelineFrames);
const positiveFrames=integer(AUDIO_PREVIEW_LIMITS.timelineFrames,1);
const revision=integer(Number.MAX_SAFE_INTEGER,1);
const sourceFrame=integer(Number.MAX_SAFE_INTEGER-AUDIO_PREVIEW_LIMITS.timelineFrames);
const gain=z.number().finite().min(0).max(2);
const inputFields={projectId:id,timelineId:id,expectedRevision:revision,startFrame:integer(17999)};

export const audioPreviewPlanInputSchema=z.object(inputFields).strict();
export const audioPreviewSourceInputSchema=z.object({
  ...inputFields,clipId:id,sourceHash:digest,planHash:digest,
}).strict();
export const audioPreviewSchemas=Object.freeze({'timeline.audioPreview.plan':audioPreviewPlanInputSchema});
export type AudioPreviewPlanInput=z.infer<typeof audioPreviewPlanInputSchema>;
export type AudioPreviewSourceInput=z.infer<typeof audioPreviewSourceInputSchema>;

const rangeSchema=z.object({
  startFrame:integer(17999),endFrame:positiveFrames,
  startSample:integer(28_798_400),endSample:integer(28_800_000,1),
  sampleFrames:integer(960_000,1600),
}).strict();
const decodeSegmentSchema=z.object({
  sourceInFrame:integer(17999),frameCount:positiveFrames,
  trimStartFrame:integer(17999),outputFrames:integer(600,1),
}).strict();
const sourceSchema=z.object({
  sourceKey:digest,profileId:z.literal(AUDIO_PREVIEW_PROFILE),clipId:id,assetId:id,
  sourceHash:digest,sourceInFrame:integer(17999),durationFrames:integer(600,1),
  sampleFrames:integer(960_000,1600),pcmBytes:integer(7_680_000,12_800),
  sourceBytes:integer(AUDIO_PREVIEW_LIMITS.sourceBytes,1),
  decodeSegments:z.array(decodeSegmentSchema).min(1).max(AUDIO_PREVIEW_LIMITS.totalDecodeSegments),
}).strict();
const voiceSchema=z.object({
  clipId:id,trackId:id,sourceKey:digest,startFrame:frame,durationFrames:positiveFrames,
  sourceInFrame:integer(17999),gain,fadeInFrames:frame,fadeOutFrames:frame,
  intersectionStartFrame:integer(17999),intersectionEndFrame:positiveFrames,
}).strict();
const memorySchema=z.object({
  retainedPcmBytes:integer(AUDIO_PREVIEW_LIMITS.memoryBytes),
  largestSourcePcmBytes:integer(7_680_000),
  transportReserveBytes:z.literal(AUDIO_PREVIEW_LIMITS.transportReserveBytes),
  admittedBytes:integer(AUDIO_PREVIEW_LIMITS.memoryBytes,AUDIO_PREVIEW_LIMITS.transportReserveBytes),
  hashReadBytes:integer(AUDIO_PREVIEW_LIMITS.hashReadBytes),
}).strict();
const workSchema=z.object({
  // Original segments, including the one-frame input lookahead used by export
  // and preview for every independent decoder run, even at the source end.
  decodedSourceFrames:integer(AUDIO_PREVIEW_LIMITS.decodeWorkFrames),
  decodeSegments:integer(AUDIO_PREVIEW_LIMITS.totalDecodeSegments),
}).strict();

export type AudioPreviewDecodeSegment=z.infer<typeof decodeSegmentSchema>;
export type AudioPreviewSourceDescriptor=z.infer<typeof sourceSchema>;
export type AudioPreviewVoice=z.infer<typeof voiceSchema>;

function sourceIdentity(source:Pick<AudioPreviewSourceDescriptor,'assetId'|'sourceHash'|'sourceInFrame'|'durationFrames'|'profileId'|'decodeSegments'>):string {
  return canonical({assetId:source.assetId,sourceHash:source.sourceHash,
    sourceInFrame:source.sourceInFrame,durationFrames:source.durationFrames,profileId:source.profileId,
    decodeSegments:source.decodeSegments});
}

export const audioPreviewPlanSchema=z.object({
  schemaVersion:z.literal(1),status:z.literal('planned'),profileId:z.literal(AUDIO_PREVIEW_PROFILE),
  projectId:id,timelineId:id,timelineRevision:revision,planHash:digest,
  range:rangeSchema,sources:z.array(sourceSchema).max(100),voices:z.array(voiceSchema).max(100),memory:memorySchema,work:workSchema,
}).strict().superRefine((plan,context)=>{
  const fail=(message:string):void=>context.addIssue({code:'custom',message});
  const range=plan.range;
  if(range.endFrame<=range.startFrame||range.endFrame-range.startFrame>AUDIO_PREVIEW_LIMITS.windowFrames||
      range.startSample!==range.startFrame*1600||range.endSample!==range.endFrame*1600||
      range.sampleFrames!==range.endSample-range.startSample)fail('Invalid half-open preview range or sample clock.');
  const sources=new Map<string,AudioPreviewSourceDescriptor>(),identities=new Set<string>();
  let retained=0,largest=0,hashReads=0,decodedSourceFrames=0,decodeSegments=0;
  for(const source of plan.sources){
    const identity=sourceIdentity(source);
    if(sources.has(source.sourceKey)||identities.has(identity))fail('Duplicate source identity.');
    sources.set(source.sourceKey,source);identities.add(identity);
    if(source.sampleFrames!==source.durationFrames*1600||source.pcmBytes!==source.sampleFrames*8||
        source.sourceInFrame+source.durationFrames>18000)fail('Invalid source sample count or bounds.');
    let outputFrames=0,previousEnd:number|undefined;
    for(const segment of source.decodeSegments){
      if(segment.sourceInFrame+segment.frameCount>18000||segment.trimStartFrame+segment.outputFrames>segment.frameCount||
          segment.sourceInFrame+segment.trimStartFrame!==source.sourceInFrame+outputFrames||
          previousEnd!==undefined&&segment.sourceInFrame!==previousEnd)
        fail('Invalid original decode segment bounds, order, or selected output.');
      outputFrames+=segment.outputFrames;previousEnd=segment.sourceInFrame+segment.frameCount;
      decodedSourceFrames+=segment.frameCount+1;decodeSegments++;
    }
    if(outputFrames!==source.durationFrames)fail('Decode segments do not cover the exact prepared source.');
    retained+=source.pcmBytes;largest=Math.max(largest,source.pcmBytes);hashReads+=2*source.sourceBytes;
  }
  const clips=new Set<string>(),usedSources=new Set<string>(),tracks=new Map<string,AudioPreviewVoice[]>();
  for(const voice of plan.voices){
    const end=voice.startFrame+voice.durationFrames,source=sources.get(voice.sourceKey);
    if(clips.has(voice.clipId))fail('Duplicate voice clip.');
    clips.add(voice.clipId);usedSources.add(voice.sourceKey);
    if(!tracks.has(voice.trackId))tracks.set(voice.trackId,[]);
    tracks.get(voice.trackId)!.push(voice);
    if(end>18000||voice.sourceInFrame+voice.durationFrames>18000||voice.gain===0||
        voice.fadeInFrames+voice.fadeOutFrames>voice.durationFrames||
        voice.intersectionStartFrame!==Math.max(range.startFrame,voice.startFrame)||
        voice.intersectionEndFrame!==Math.min(range.endFrame,end)||
        voice.intersectionEndFrame<=voice.intersectionStartFrame)fail('Invalid original clip or prepared intersection.');
    if(!source||source.sourceInFrame!==voice.sourceInFrame+voice.intersectionStartFrame-voice.startFrame||
        source.durationFrames!==voice.intersectionEndFrame-voice.intersectionStartFrame)fail('Voice does not match its exact prepared source.');
    if(source?.decodeSegments.some(segment=>segment.sourceInFrame<voice.sourceInFrame||
        segment.sourceInFrame+segment.frameCount>voice.sourceInFrame+voice.durationFrames))
      fail('Original decode segment exceeds its saved voice clip.');
  }
  if(tracks.size>AUDIO_PREVIEW_LIMITS.tracks)fail('Too many tracks.');
  for(const voices of tracks.values()){
    voices.sort((a,b)=>a.startFrame-b.startFrame);
    for(let i=1;i<voices.length;i++)if(voices[i]!.startFrame<voices[i-1]!.startFrame+voices[i-1]!.durationFrames)fail('Overlapping saved clips on one track.');
  }
  for(const source of plan.sources){
    if(!usedSources.has(source.sourceKey)||!plan.voices.some(voice=>voice.clipId===source.clipId&&voice.sourceKey===source.sourceKey))fail('Source has no representative saved clip.');
  }
  const memory=plan.memory,admitted=2*retained+2*largest+AUDIO_PREVIEW_LIMITS.transportReserveBytes;
  if(memory.retainedPcmBytes!==retained||memory.largestSourcePcmBytes!==largest||memory.hashReadBytes!==hashReads||
      memory.admittedBytes!==admitted||admitted>AUDIO_PREVIEW_LIMITS.memoryBytes||hashReads>AUDIO_PREVIEW_LIMITS.hashReadBytes)fail('Resource accounting does not match all distinct prepared sources.');
  if(plan.work.decodedSourceFrames!==decodedSourceFrames||plan.work.decodeSegments!==decodeSegments||
      decodedSourceFrames>AUDIO_PREVIEW_LIMITS.decodeWorkFrames||decodeSegments>AUDIO_PREVIEW_LIMITS.totalDecodeSegments)
    fail('Decode work accounting does not match all distinct original segments.');
  if(new TextEncoder().encode(JSON.stringify(plan)).byteLength>AUDIO_PREVIEW_LIMITS.planBytes)fail('Preview plan exceeds its bounded JSON size.');
});
export type AudioPreviewPlan=z.infer<typeof audioPreviewPlanSchema>;

const trackSchema=z.object({id,kind:z.enum(['video','audio']),orderIndex:integer(11),hidden:z.boolean(),muted:z.boolean()}).strict();
const clipSchema=z.object({
  id,trackId:id,assetId:id,startFrame:frame,durationFrames:positiveFrames,sourceInFrame:sourceFrame,gain,
  fadeInFrames:frame.optional(),fadeOutFrames:frame.optional(),
}).strict();
const assetSchema=z.object({
  id,projectId:id,sha256:digest,sizeBytes:integer(Number.MAX_SAFE_INTEGER,1),
  mimeType:z.enum(['image/png','image/jpeg','image/webp','video/mp4','video/webm','audio/wav','audio/mpeg','audio/mp4']),
  duration:z.number().finite().nonnegative().nullable(),hasAudio:z.boolean().nullable().optional(),
}).strict();
const snapshotSchema=z.object({
  timeline:z.object({id,projectId:id,revision,fps:z.literal(30),durationFrames:frame,
    tracks:z.array(trackSchema).min(1).max(12),clips:z.array(clipSchema).max(100)}).strict(),
  assets:z.array(assetSchema).max(100),
}).strict();
/** Backend projection after the complete saved timeline and ownership-graph
 * guard. No file paths, private provenance, or caller-selected decoder fields. */
export type AudioPreviewSnapshot=z.infer<typeof snapshotSchema>;

export type AudioPreviewPlanErrorCode='AUDIO_PREVIEW_INVALID_INPUT'|'AUDIO_PREVIEW_INVALID_SNAPSHOT'|
  'AUDIO_PREVIEW_REVISION_CONFLICT'|'AUDIO_PREVIEW_RANGE_BOUNDS'|'AUDIO_PREVIEW_SOURCE_LIMIT'|
  'AUDIO_PREVIEW_MEMORY_LIMIT'|'AUDIO_PREVIEW_HASH_LIMIT'|'AUDIO_PREVIEW_AUDIO_UNKNOWN'|'AUDIO_PREVIEW_BUDGET';
function fail(code:AudioPreviewPlanErrorCode,message:string):never {
  throw Object.assign(new Error(message),{code});
}

/** Bound plain data before getters, toJSON, cycles, or huge graphs can enter
 * the pure builder/digest boundary. This is not a general object serializer. */
function boundedPlainData(value:unknown):boolean {
  const ancestors=new Set<object>();let nodes=12000;
  const visit=(item:unknown,depth:number):boolean=>{
    if(--nodes<0||depth>8)return false;
    if(item===null||typeof item==='boolean')return true;
    if(typeof item==='number')return Number.isFinite(item);
    if(typeof item==='string')return item.length<=256;
    if(typeof item!=='object'||ancestors.has(item))return false;
    const array=Array.isArray(item);
    if(array?(Object.getPrototypeOf(item)!==Array.prototype||item.length>200):
        ![Object.prototype,null].includes(Object.getPrototypeOf(item)))return false;
    const keys=Reflect.ownKeys(item);
    if(keys.length>(array?201:32)||array&&keys.length!==item.length+1)return false;
    ancestors.add(item);
    for(const key of keys){
      if(array&&key==='length')continue;
      if(typeof key!=='string'||array&&(!/^(?:0|[1-9][0-9]*)$/u.test(key)||Number(key)>=item.length))return false;
      const descriptor=Object.getOwnPropertyDescriptor(item,key);
      if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||!visit(descriptor.value,depth+1))return false;
    }
    ancestors.delete(item);return true;
  };
  try{return visit(value,0)&&new TextEncoder().encode(JSON.stringify(value)).byteLength<=AUDIO_PREVIEW_LIMITS.planBytes;}
  catch{return false;}
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object'){
    const object=value as Record<string,unknown>;
    return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) as string;
}

/** Canonical public content, excluding only its own digest. Server source
 * requests must rederive this from saved data, never accept a renderer plan. */
export function audioPreviewPlanDigestMaterial(plan:AudioPreviewPlan):string {
  if(!boundedPlainData(plan))fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid preview plan data.');
  const checked=audioPreviewPlanSchema.safeParse(plan);
  if(!checked.success)fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid preview plan.');
  const {planHash:omitted,...material}=checked.data;
  void omitted;
  return canonical(material);
}

/** Bounded structural and requested-identity guard. A JSON response cannot
 * prove its own SHA-256; callers may additionally hash the canonical material.
 * The exact saved end is determined by the authoritative builder, not input. */
export function isAudioPreviewPlan(value:unknown,input:AudioPreviewPlanInput):value is AudioPreviewPlan {
  try{
    if(!boundedPlainData(input)||!boundedPlainData(value))return false;
    const request=audioPreviewPlanInputSchema.safeParse(input),plan=audioPreviewPlanSchema.safeParse(value);
    return request.success&&plan.success&&plan.data.projectId===request.data.projectId&&
      plan.data.timelineId===request.data.timelineId&&plan.data.timelineRevision===request.data.expectedRevision&&
      plan.data.range.startFrame===request.data.startFrame;
  }catch{return false;}
}

export interface TimelineAudioSampleClip {
  startFrame:number;durationFrames:number;sourceInFrame:number;fadeInFrames?:number;fadeOutFrames?:number;
}
export interface TimelineAudioSamples {
  startSample:number;endSample:number;durationSamples:number;sourceInSample:number;
  offsetSamples:number;sourceSample:number;fadeInSamples:number;fadeOutSamples:number;fadeOutStartSample:number;
}
/** Integer clock shared with export's existing clip-relative FFmpeg fades.
 * fadeOutStartSample is clip-local; startSample/endSample are timeline-global. */
export function deriveTimelineAudioSamples(clip:TimelineAudioSampleClip,segmentStartFrame:number):TimelineAudioSamples {
  const fadeIn=clip.fadeInFrames===undefined?0:clip.fadeInFrames,fadeOut=clip.fadeOutFrames===undefined?0:clip.fadeOutFrames;
  const integral=(value:number,min:number,max:number):boolean=>Number.isSafeInteger(value)&&value>=min&&value<=max;
  if(!integral(clip.startFrame,0,18000)||!integral(clip.durationFrames,1,18000)||
      clip.startFrame+clip.durationFrames>18000||
      !integral(clip.sourceInFrame,0,Math.floor(Number.MAX_SAFE_INTEGER/1600)-18000)||
      !integral(fadeIn,0,clip.durationFrames)||!integral(fadeOut,0,clip.durationFrames)||fadeIn+fadeOut>clip.durationFrames||
      !integral(segmentStartFrame,clip.startFrame,clip.startFrame+clip.durationFrames))
    fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid clip sample mapping.');
  return {startSample:clip.startFrame*1600,endSample:(clip.startFrame+clip.durationFrames)*1600,
    durationSamples:clip.durationFrames*1600,sourceInSample:clip.sourceInFrame*1600,
    offsetSamples:(segmentStartFrame-clip.startFrame)*1600,
    sourceSample:(clip.sourceInFrame+segmentStartFrame-clip.startFrame)*1600,
    fadeInSamples:fadeIn*1600,fadeOutSamples:fadeOut*1600,fadeOutStartSample:(clip.durationFrames-fadeOut)*1600};
}

/** Half-open output, with original clip-local fades after windowing or seek.
 * This computes one scalar, not a limiter or normalization across voices. */
export function audioPreviewEnvelopeAtSample(voice:AudioPreviewVoice,globalSample:number):number {
  if(!Number.isSafeInteger(globalSample)||!Number.isFinite(voice.gain)||voice.gain<0||voice.gain>2)
    fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid envelope sample or gain.');
  const samples=deriveTimelineAudioSamples(voice,voice.intersectionStartFrame);
  if(!Number.isSafeInteger(voice.intersectionEndFrame)||voice.intersectionEndFrame<=voice.intersectionStartFrame||
      voice.intersectionEndFrame>voice.startFrame+voice.durationFrames)
    fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid envelope intersection.');
  if(globalSample<samples.startSample||globalSample>=samples.endSample||
      globalSample<voice.intersectionStartFrame*1600||globalSample>=voice.intersectionEndFrame*1600)return 0;
  return audioPreviewEnvelopeGainAtLocalSample(voice,globalSample-samples.startSample);
}

/** Continuous envelope used for Web Audio ramp endpoints, including the
 * left-hand gain at clip end. It does not assert the clip is playing there.
 * An interior prepared-window endpoint must not introduce an artificial fade. */
export function audioPreviewEnvelopeGainAtLocalSample(voice:AudioPreviewVoice,localSample:number):number {
  const samples=deriveTimelineAudioSamples(voice,voice.startFrame);
  if(!Number.isSafeInteger(localSample)||localSample<0||localSample>samples.durationSamples||
      !Number.isFinite(voice.gain)||voice.gain<0||voice.gain>2)
    fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid continuous envelope sample or gain.');
  const local=localSample;
  const fadeIn=samples.fadeInSamples===0?1:Math.min(1,local/samples.fadeInSamples);
  const fadeOut=samples.fadeOutSamples===0?1:Math.min(1,(samples.durationSamples-local)/samples.fadeOutSamples);
  return voice.gain*fadeIn*fadeOut;
}

/** Pure and bounded. hashText must be a trusted synchronous SHA-256 adapter.
 * The business service separately owns restored-workspace, file, graph, and
 * cancellation guards. This function performs no reads, writes, or decoding. */
export function buildAudioPreviewPlan(
  rawInput:unknown,rawSnapshot:unknown,hashText:(text:string)=>string,
):AudioPreviewPlan {
  if(!boundedPlainData(rawInput))fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid preview input data.');
  const parsedInput=audioPreviewPlanInputSchema.safeParse(rawInput);
  if(!parsedInput.success)fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid preview input.');
  if(!boundedPlainData(rawSnapshot))fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Invalid saved preview data.');
  const parsedSnapshot=snapshotSchema.safeParse(rawSnapshot);
  if(!parsedSnapshot.success)fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Invalid saved preview snapshot.');
  const input=parsedInput.data,{timeline,assets}=parsedSnapshot.data;
  if(timeline.projectId!==input.projectId||timeline.id!==input.timelineId)
    fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Preview timeline identity does not match.');
  if(timeline.revision!==input.expectedRevision)fail('AUDIO_PREVIEW_REVISION_CONFLICT','Saved timeline revision changed.');
  if(input.startFrame>=timeline.durationFrames)fail('AUDIO_PREVIEW_RANGE_BOUNDS','Preview start must be inside the saved timeline.');
  const trackMap=new Map<string,z.infer<typeof trackSchema>>(),assetMap=new Map<string,z.infer<typeof assetSchema>>();
  for(const track of timeline.tracks){
    if(trackMap.has(track.id)||track.kind==='audio'&&track.hidden)fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Invalid saved track.');
    trackMap.set(track.id,track);
  }
  for(const asset of assets){
    if(assetMap.has(asset.id)||asset.projectId!==input.projectId)fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Invalid owned asset identity.');
    assetMap.set(asset.id,asset);
  }
  const ids=new Set<string>(),byTrack=new Map<string,z.infer<typeof clipSchema>[]>();let duration=0;
  for(const clip of timeline.clips){
    const track=trackMap.get(clip.trackId),asset=assetMap.get(clip.assetId),end=clip.startFrame+clip.durationFrames;
    if(ids.has(clip.id)||!track||!asset||end>18000)fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Unresolvable saved clip.');
    ids.add(clip.id);duration=Math.max(duration,end);
    const image=asset.mimeType.startsWith('image/'),audio=asset.mimeType.startsWith('audio/'),video=asset.mimeType.startsWith('video/');
    if(track.kind==='audio'?!audio:!image&&!video)fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Source type does not match its track.');
    if(image&&asset.hasAudio===true)fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Image asset has contradictory audio metadata.');
    if(!image&&typeof asset.hasAudio!=='boolean')fail('AUDIO_PREVIEW_AUDIO_UNKNOWN','Saved source audio metadata is unknown.');
    const fadeIn=clip.fadeInFrames??0,fadeOut=clip.fadeOutFrames??0;
    if(fadeIn+fadeOut>clip.durationFrames||(fadeIn>0||fadeOut>0)&&asset.hasAudio!==true)
      fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Invalid saved audio fade.');
    if(image?clip.sourceInFrame!==0:asset.duration===null||asset.duration<=0||
        clip.sourceInFrame+clip.durationFrames>Math.floor(asset.duration*30+1e-6))
      fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Saved clip exceeds the source range.');
    if(!byTrack.has(clip.trackId))byTrack.set(clip.trackId,[]);
    byTrack.get(clip.trackId)!.push(clip);
  }
  if(duration!==timeline.durationFrames)fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Saved timeline duration does not match its clips.');
  for(const clips of byTrack.values()){
    clips.sort((a,b)=>a.startFrame-b.startFrame);
    for(let i=1;i<clips.length;i++)if(clips[i]!.startFrame<clips[i-1]!.startFrame+clips[i-1]!.durationFrames)
      fail('AUDIO_PREVIEW_INVALID_SNAPSHOT','Saved clips overlap on one track.');
  }
  const checkedHash=(text:string):string=>{
    if(typeof hashText!=='function')fail('AUDIO_PREVIEW_INVALID_INPUT','A trusted hash adapter is required.');
    const result=hashText(text);
    if(!digest.safeParse(result).success)fail('AUDIO_PREVIEW_INVALID_INPUT','Invalid hash adapter result.');
    return result;
  };
  const startFrame=input.startFrame,endFrame=Math.min(startFrame+600,timeline.durationFrames);
  const compositionSegments=timelineCompositionSegments(timeline);
  const sources:AudioPreviewSourceDescriptor[]=[],voices:AudioPreviewVoice[]=[],sourceMap=new Map<string,AudioPreviewSourceDescriptor>();
  const ordered=[...timeline.clips].sort((a,b)=>trackMap.get(a.trackId)!.orderIndex-trackMap.get(b.trackId)!.orderIndex||
    (a.id<b.id?-1:a.id>b.id?1:0));
  let retained=0,largest=0,hashReads=0,decodedSourceFrames=0,decodeSegments=0;
  for(const clip of ordered){
    const track=trackMap.get(clip.trackId)!,asset=assetMap.get(clip.assetId)!;
    const intersectionStartFrame=Math.max(startFrame,clip.startFrame),intersectionEndFrame=Math.min(endFrame,clip.startFrame+clip.durationFrames);
    if(track.muted||clip.gain===0||asset.hasAudio!==true||intersectionStartFrame>=intersectionEndFrame)continue;
    if(asset.sizeBytes>AUDIO_PREVIEW_LIMITS.sourceBytes||asset.duration===null||asset.duration>AUDIO_PREVIEW_LIMITS.sourceSeconds)
      fail('AUDIO_PREVIEW_SOURCE_LIMIT','Preview source exceeds the input size or duration limit.');
    const sourceInFrame=clip.sourceInFrame+intersectionStartFrame-clip.startFrame,durationFrames=intersectionEndFrame-intersectionStartFrame;
    const segments:AudioPreviewDecodeSegment[]=[];
    for(const segment of compositionSegments){
      if(segment.beginFrame<clip.startFrame||segment.endFrame>clip.startFrame+clip.durationFrames)continue;
      const from=Math.max(startFrame,segment.beginFrame),to=Math.min(endFrame,segment.endFrame);
      if(from>=to)continue;
      segments.push({sourceInFrame:clip.sourceInFrame+segment.beginFrame-clip.startFrame,
        frameCount:segment.endFrame-segment.beginFrame,trimStartFrame:from-segment.beginFrame,outputFrames:to-from});
    }
    const identity=sourceIdentity({assetId:asset.id,sourceHash:asset.sha256,sourceInFrame,durationFrames,
      profileId:AUDIO_PREVIEW_PROFILE,decodeSegments:segments});
    let source=sourceMap.get(identity);
    if(!source){
      const sampleFrames=durationFrames*1600,pcmBytes=sampleFrames*8;
      source={sourceKey:checkedHash(identity),profileId:AUDIO_PREVIEW_PROFILE,clipId:clip.id,assetId:asset.id,
        sourceHash:asset.sha256,sourceInFrame,durationFrames,sampleFrames,pcmBytes,sourceBytes:asset.sizeBytes,decodeSegments:segments};
      sourceMap.set(identity,source);sources.push(source);
      retained+=pcmBytes;largest=Math.max(largest,pcmBytes);hashReads+=2*asset.sizeBytes;
      decodedSourceFrames+=segments.reduce((sum,segment)=>sum+segment.frameCount+1,0);decodeSegments+=segments.length;
    }
    voices.push({clipId:clip.id,trackId:clip.trackId,sourceKey:source.sourceKey,startFrame:clip.startFrame,
      durationFrames:clip.durationFrames,sourceInFrame:clip.sourceInFrame,gain:clip.gain,
      fadeInFrames:clip.fadeInFrames??0,fadeOutFrames:clip.fadeOutFrames??0,intersectionStartFrame,intersectionEndFrame});
  }
  const admittedBytes=2*retained+2*largest+AUDIO_PREVIEW_LIMITS.transportReserveBytes;
  if(admittedBytes>AUDIO_PREVIEW_LIMITS.memoryBytes)fail('AUDIO_PREVIEW_MEMORY_LIMIT','The complete preview interval exceeds the PCM memory budget.');
  if(hashReads>AUDIO_PREVIEW_LIMITS.hashReadBytes)fail('AUDIO_PREVIEW_HASH_LIMIT','The complete preview interval exceeds the source hash-read budget.');
  if(decodedSourceFrames>AUDIO_PREVIEW_LIMITS.decodeWorkFrames||decodeSegments>AUDIO_PREVIEW_LIMITS.totalDecodeSegments)
    fail('AUDIO_PREVIEW_BUDGET','The complete preview interval exceeds the original-segment decode work budget.');
  const plan:AudioPreviewPlan={schemaVersion:1,status:'planned',profileId:AUDIO_PREVIEW_PROFILE,
    projectId:input.projectId,timelineId:input.timelineId,timelineRevision:timeline.revision,planHash:'0'.repeat(64),
    range:{startFrame,endFrame,startSample:startFrame*1600,endSample:endFrame*1600,sampleFrames:(endFrame-startFrame)*1600},
    sources,voices,memory:{retainedPcmBytes:retained,largestSourcePcmBytes:largest,
      transportReserveBytes:AUDIO_PREVIEW_LIMITS.transportReserveBytes,admittedBytes,hashReadBytes:hashReads},
    work:{decodedSourceFrames,decodeSegments}};
  plan.planHash=checkedHash(audioPreviewPlanDigestMaterial(plan));
  return plan;
}
