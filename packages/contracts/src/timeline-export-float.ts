import {z} from 'zod';
import {timelineExportOutputFrames} from './timeline-export-range.ts';
import {timelineRenderDeliveryFields} from './timeline-delivery.ts';
import {timelineDeliveryGeometry,timelineOutputPreset} from './timeline-output-geometry.ts';
import type {TimelineOutputResolution,TimelineOutputGeometry} from './timeline-output-geometry.ts';

/** Opt-in export policy only. Neither this profile nor a within-limit report
 * promises AAC reconstruction, true-peak, loudness or source-clipping safety. */
export const TIMELINE_EXPORT_FLOAT_PROFILE_ID = 'mp4_h264_float_checked_v2';
export const TIMELINE_EXPORT_FLOAT_POLICY_ID = 'preencode_sample_peak_reject_over_one_v1';
export const TIMELINE_EXPORT_FLOAT_LIMITS = Object.freeze({
  outputFrames:18000, sampleFrames:28_800_000, sampleCount:57_600_000,
  pcmBytes:230_400_000, reportBytes:8*1024, timeoutMs:120_000,
});

export type TimelineExportResolution = TimelineOutputResolution;
export type TimelineExportRateControl =
  | {mode:'crf';quality:'compact'|'standard'|'high'}
  | {mode:'bitrate';targetKbps:2000|4000|8000};
export interface TimelineExportSettingsV1 {
  profileId:'mp4_h264_v1';resolution:TimelineExportResolution;rateControl:TimelineExportRateControl;
}
export interface TimelineExportSettingsV2 {
  profileId:typeof TIMELINE_EXPORT_FLOAT_PROFILE_ID;
  resolution:TimelineExportResolution;rateControl:TimelineExportRateControl;
}
export type TimelineExportSettings = TimelineExportSettingsV1|TimelineExportSettingsV2;

const bitrate = z.union([z.literal(2000),z.literal(4000),z.literal(8000)]);
export const timelineExportFloatSettingsSchema = z.object({
  profileId:z.literal(TIMELINE_EXPORT_FLOAT_PROFILE_ID),resolution:z.enum(['native','short_360','short_720','short_1080']),
  rateControl:z.discriminatedUnion('mode',[
    z.object({mode:z.literal('crf'),quality:z.enum(['compact','standard','high'])}).strict(),
    z.object({mode:z.literal('bitrate'),targetKbps:bitrate}).strict(),
  ]),
}).strict().describe('Explicit export-only float intermediate profile. The complete pre-encode sample peak must not exceed one; otherwise the export fails without publishing an asset. No automatic gain change. This is not an AAC or true-peak safety guarantee.');

export const timelineExportFloatEffectiveSchema = z.object({
  profileId:z.literal(TIMELINE_EXPORT_FLOAT_PROFILE_ID),container:z.literal('mp4'),
  width:z.number().int().min(2).max(1920).multipleOf(2),height:z.number().int().min(2).max(1920).multipleOf(2),fps:z.literal(30),
  videoCodec:z.literal('libx264'),pixelFormat:z.literal('yuv420p'),preset:z.literal('veryfast'),
  rateControl:z.discriminatedUnion('mode',[
    z.object({mode:z.literal('crf'),crf:z.union([z.literal(28),z.literal(23),z.literal(18)])}).strict(),
    z.object({mode:z.literal('bitrate'),targetKbps:bitrate}).strict(),
  ]),
  bFrames:z.literal(0),gopFrames:z.literal(60),videoTrackTimescale:z.literal(30000),scaling:z.literal('lanczos'),
  audioCodec:z.literal('aac'),audioKbps:z.literal(128),audioSampleRate:z.literal(48000),audioChannels:z.literal(2),movflags:z.literal('faststart'),
  intermediateAudio:z.object({container:z.literal('mov'),codec:z.literal('pcm_f32le'),sampleFormat:z.literal('flt'),sampleRate:z.literal(48000),channels:z.literal(2)}).strict(),
  preencodeAudioPolicy:z.object({policyId:z.literal(TIMELINE_EXPORT_FLOAT_POLICY_ID),maxPeakLinear:z.literal(1),overRange:z.literal('reject')}).strict(),
}).strict();
export type TimelineExportEffectiveV2 = z.infer<typeof timelineExportFloatEffectiveSchema>;
export type TimelineExportEffectiveV1 = Omit<TimelineExportEffectiveV2,'profileId'|'intermediateAudio'|'preencodeAudioPolicy'> & {profileId:'mp4_h264_v1'};
export const timelineExportFloatDeliverySchema = z.object({
  exportSettings:timelineExportFloatSettingsSchema,effective:timelineExportFloatEffectiveSchema,
}).strict();
export type TimelineExportFloatDelivery = z.infer<typeof timelineExportFloatDeliverySchema>;
export type TimelineExportDelivery = TimelineExportFloatDelivery|{exportSettings:TimelineExportSettingsV1;effective:TimelineExportEffectiveV1};

const object = (value:unknown):value is Record<string,unknown> => value!==null&&typeof value==='object'&&!Array.isArray(value);
const own = (value:object,key:PropertyKey):boolean => Object.hasOwn(value,key);
const same = (a:unknown,b:unknown):boolean => object(a)&&object(b)
  ? Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>own(b,key)&&same(a[key],b[key])) : a===b;
function invalid():never {throw Object.assign(new Error('Invalid timeline export delivery profile'),{code:'INVALID_TIMELINE_SNAPSHOT'});}
function isGeometry(value:unknown):value is TimelineOutputGeometry {
  return timelineOutputPreset(value)!==null;
}

/** Separate v2 resolver; the old resolver's object order and bytes are untouched. */
export function resolveTimelineExportFloatDelivery(timeline:unknown,settings:unknown):TimelineExportFloatDelivery {
  const parsed=timelineExportFloatSettingsSchema.safeParse(settings);
  if(!isGeometry(timeline)||!parsed.success)invalid();
  const exportSettings=parsed.data,geometry=timelineDeliveryGeometry(timeline,exportSettings.resolution);
  if(!geometry)invalid();
  const rate=exportSettings.rateControl;
  return {exportSettings:JSON.parse(JSON.stringify(settings)) as TimelineExportSettingsV2,effective:{
    profileId:TIMELINE_EXPORT_FLOAT_PROFILE_ID,container:'mp4',width:geometry.width,height:geometry.height,fps:30,
    videoCodec:'libx264',pixelFormat:'yuv420p',preset:'veryfast',
    rateControl:rate.mode==='crf'?{mode:'crf',crf:({compact:28,standard:23,high:18} as const)[rate.quality]}:{mode:'bitrate',targetKbps:rate.targetKbps},
    bFrames:0,gopFrames:60,videoTrackTimescale:30000,scaling:'lanczos',audioCodec:'aac',audioKbps:128,audioSampleRate:48000,audioChannels:2,movflags:'faststart',
    intermediateAudio:{container:'mov',codec:'pcm_f32le',sampleFormat:'flt',sampleRate:48000,channels:2},
    preencodeAudioPolicy:{policyId:TIMELINE_EXPORT_FLOAT_POLICY_ID,maxPeakLinear:1,overRange:'reject'},
  }};
}
export function isTimelineExportFloatDelivery(value:unknown,timeline:unknown,settings?:unknown):value is TimelineExportFloatDelivery {
  try{return timelineExportFloatDeliverySchema.safeParse(value).success&&isGeometry(timeline)&&object(value)&&
    (settings===undefined||same(value.exportSettings,settings))&&same(value,resolveTimelineExportFloatDelivery(timeline,value.exportSettings));}
  catch{return false;}
}
/** Profile discriminator after the caller's complete snapshot/ownership guard. */
export function isTimelineExportFloatSnapshot(snapshot:unknown):boolean {
  return object(snapshot)&&isTimelineExportFloatDelivery(snapshot.delivery,snapshot.timeline);
}

const id=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/u);
const count=(max:number):z.ZodNumber=>z.number().int().min(0).max(max);
const peak=z.number().finite().nonnegative().max(3.4028234663852886e38);
const channelFields={peakLinear:peak,overRangeSampleCount:count(TIMELINE_EXPORT_FLOAT_LIMITS.sampleFrames)};
export const timelineExportAudioMeasurementSchema=z.object({
  sampleRate:z.literal(48000),channels:z.literal(2),sampleFormat:z.literal('f32le'),
  sampleFrames:count(TIMELINE_EXPORT_FLOAT_LIMITS.sampleFrames).min(1),
  sampleCount:count(TIMELINE_EXPORT_FLOAT_LIMITS.sampleCount).min(2),
  peakLinear:peak,overRangeSampleCount:count(TIMELINE_EXPORT_FLOAT_LIMITS.sampleCount),
  channelPeaks:z.tuple([
    z.object({channel:z.literal(0),...channelFields}).strict(),
    z.object({channel:z.literal(1),...channelFields}).strict(),
  ]),
}).strict().superRefine((value,context)=>{
  const fail=(message:string):void=>context.addIssue({code:'custom',message});
  if(value.sampleCount!==value.sampleFrames*2)fail('Sample count must contain exactly two channel samples per frame.');
  if(value.peakLinear!==Math.max(value.channelPeaks[0].peakLinear,value.channelPeaks[1].peakLinear))fail('Overall peak must equal the maximum channel peak.');
  if(value.overRangeSampleCount!==value.channelPeaks[0].overRangeSampleCount+value.channelPeaks[1].overRangeSampleCount)fail('Overall over-range count must equal the channel count sum.');
  for(const channel of value.channelPeaks){
    if(channel.overRangeSampleCount>value.sampleFrames)fail('Channel over-range count exceeds the complete frame count.');
    if((channel.peakLinear>1)!==(channel.overRangeSampleCount>0))fail('Over-range counts must match peaks strictly greater than one.');
  }
});
export type TimelineExportAudioMeasurement=z.infer<typeof timelineExportAudioMeasurementSchema>;

export const TIMELINE_EXPORT_AUDIO_INCOMPLETE_CODES = Object.freeze([
  'EXPORT_AUDIO_FORMAT_MISMATCH','EXPORT_AUDIO_INVALID_PCM','EXPORT_AUDIO_SAMPLE_COUNT_MISMATCH',
  'EXPORT_AUDIO_OUTPUT_LIMIT','EXPORT_AUDIO_TIMEOUT','EXPORT_AUDIO_DECODER_UNAVAILABLE',
  'EXPORT_AUDIO_DECODE_FAILED','EXPORT_AUDIO_STAGING_CHANGED','EXPORT_AUDIO_TERMINATION_UNCONFIRMED',
] as const);
export type AudioCheckIncompleteCode=typeof TIMELINE_EXPORT_AUDIO_INCOMPLETE_CODES[number];
const audioIdentity={
  schemaVersion:z.literal(1),profileId:z.literal(TIMELINE_EXPORT_FLOAT_PROFILE_ID),policyId:z.literal(TIMELINE_EXPORT_FLOAT_POLICY_ID),
  stage:z.literal('preencode_float_mix'),projectId:id,exportId:id,attemptId:id,snapshotSha256:digest,
  outputFrames:count(TIMELINE_EXPORT_FLOAT_LIMITS.outputFrames).min(1),checkedAt:z.string().max(30).datetime(),
};
export const timelineExportAudioOutputSchema=z.object({assetId:id,sha256:digest}).strict();
export type TimelineExportAudioOutput=z.infer<typeof timelineExportAudioOutputSchema>;
export const timelineExportAudioCheckSchema=z.discriminatedUnion('status',[
  z.object({...audioIdentity,status:z.literal('complete'),code:z.enum(['EXPORT_AUDIO_WITHIN_LIMIT','EXPORT_AUDIO_OVER_RANGE']),
    measurement:timelineExportAudioMeasurementSchema,output:timelineExportAudioOutputSchema.nullable()}).strict(),
  z.object({...audioIdentity,status:z.literal('incomplete'),code:z.enum(TIMELINE_EXPORT_AUDIO_INCOMPLETE_CODES),
    measurement:z.null(),output:z.null()}).strict(),
]).superRefine((value,context)=>{
  const fail=(message:string):void=>context.addIssue({code:'custom',message});
  if(value.status==='complete'){
    if(value.measurement.sampleFrames!==value.outputFrames*1600)fail('The complete float stream must contain exactly 1600 sample frames per output frame.');
    if((value.measurement.peakLinear>1)!==(value.code==='EXPORT_AUDIO_OVER_RANGE'))fail('The report code must match the strict pre-encode threshold.');
    if(value.code==='EXPORT_AUDIO_OVER_RANGE'&&value.output!==null)fail('An over-range stream must not bind a published output.');
  }
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>TIMELINE_EXPORT_FLOAT_LIMITS.reportBytes)fail('The report exceeds its bounded size.');
});
export type TimelineExportAudioCheck=z.infer<typeof timelineExportAudioCheckSchema>;

/** Bound plain JSON before Zod or JSON.stringify can invoke untrusted getters. */
function boundedAudioData(value:unknown):boolean {
  const ancestors=new Set<object>();let nodes=160;
  function visit(item:unknown,depth:number):boolean {
    if(--nodes<0||depth>7)return false;
    if(item===null||typeof item==='boolean')return true;
    if(typeof item==='number')return Number.isFinite(item);
    if(typeof item==='string')return item.length<=TIMELINE_EXPORT_FLOAT_LIMITS.reportBytes;
    if(typeof item!=='object'||ancestors.has(item))return false;
    const array=Array.isArray(item);
    if(array?(Object.getPrototypeOf(item)!==Array.prototype||item.length>2):![Object.prototype,null].includes(Object.getPrototypeOf(item)))return false;
    ancestors.add(item);const descriptors=Object.getOwnPropertyDescriptors(item),keys=Reflect.ownKeys(descriptors);
    if(keys.length>32||array&&keys.length!==item.length+1)return false;
    for(const key of keys){
      if(array&&key==='length')continue;
      if(typeof key!=='string'||array&&(!/^(?:0|[1-9][0-9]*)$/u.test(key)||Number(key)>=item.length))return false;
      const field=descriptors[key];
      if(!field||!field.enumerable||!own(field,'value')||!visit(field.value,depth+1))return false;
    }
    ancestors.delete(item);return true;
  }
  return visit(value,0)&&new TextEncoder().encode(JSON.stringify(value)).byteLength<=TIMELINE_EXPORT_FLOAT_LIMITS.reportBytes;
}
export function isTimelineExportAudioMeasurement(value:unknown,outputFrames?:number):value is TimelineExportAudioMeasurement {
  try{
    if(!boundedAudioData(value))return false;
    const parsed=timelineExportAudioMeasurementSchema.safeParse(value);
    return parsed.success&&(outputFrames===undefined||Number.isSafeInteger(outputFrames)&&outputFrames>=1&&outputFrames<=18000&&parsed.data.sampleFrames===outputFrames*1600);
  }catch{return false;}
}
export function isTimelineExportAudioCheck(value:unknown):value is TimelineExportAudioCheck {
  try{return boundedAudioData(value)&&timelineExportAudioCheckSchema.safeParse(value).success;}catch{return false;}
}

export interface TimelineExportAudioOutcomeBinding {
  /** Backend-only raw frozen snapshot digest; public snapshots omit paths. */
  snapshotSha256?:string;
  /** Backend-only hash from the independently owned published output asset. */
  assetSha256?:string;
}
/** Additive guard called by the complete existing render-record validator.
 * It never rewrites a row or populates missing keys on old records. */
export function isTimelineExportAudioOutcome(value:unknown,binding:TimelineExportAudioOutcomeBinding={}):boolean {
  try{
    if(!object(value))return false;
    const hasAttempt=own(value,'renderAttemptId'),hasReport=own(value,'audioCheck');
    if(!isTimelineExportFloatSnapshot(value.snapshot))return !hasAttempt&&!hasReport;
    if(value.mode!=='timeline'||value.purpose!=='export')return false;
    if(value.status==='queued')return !hasAttempt&&!hasReport;
    if(value.status==='running')return hasAttempt&&id.safeParse(value.renderAttemptId).success&&!hasReport;
    if(value.status!=='failed'&&value.status!=='succeeded')return false;
    if(!hasAttempt||!id.safeParse(value.renderAttemptId).success)return false;
    if(!hasReport)return value.status==='failed'&&(!object(value.error)||value.error.code!=='EXPORT_AUDIO_OVER_RANGE');
    if(!hasAttempt||!isTimelineExportAudioCheck(value.audioCheck))return false;
    const report=value.audioCheck;
    if(report.projectId!==value.projectId||report.exportId!==value.id||report.attemptId!==value.renderAttemptId||
      report.outputFrames!==timelineExportOutputFrames(value.snapshot)||
      binding.snapshotSha256!==undefined&&report.snapshotSha256!==binding.snapshotSha256)return false;
    if(value.status==='succeeded')return report.status==='complete'&&report.code==='EXPORT_AUDIO_WITHIN_LIMIT'&&
      report.output!==null&&report.output.assetId===value.assetId&&
      (binding.assetSha256===undefined||report.output.sha256===binding.assetSha256);
    if(report.output!==null)return false;
    if(report.code==='EXPORT_AUDIO_OVER_RANGE')return object(value.error)&&value.error.code===report.code&&value.error.retryable===false;
    return !object(value.error)||value.error.code!=='EXPORT_AUDIO_OVER_RANGE';
  }catch{return false;}
}

/** Narrow client read boundary. Historical generic export.get responses retain
 * their old acceptance behavior; opted-in v2 rows use the complete shared render
 * validator against frozen input only, never today's timeline or capabilities.
 * Raw private snapshot/output hash binding remains a backend responsibility. */
export function isTimelineExportFloatReadResponse(
  value:unknown,
  exportId:unknown,
  isRenderRecord:(value:unknown,input:Readonly<Record<string,unknown>>)=>boolean,
):boolean {
  try{
    if(!object(value))return true;
    const snapshot=object(value.snapshot)?value.snapshot:null;
    const delivery=snapshot&&object(snapshot.delivery)?snapshot.delivery:null;
    const settings=delivery&&object(delivery.exportSettings)?delivery.exportSettings:null;
    const effective=delivery&&object(delivery.effective)?delivery.effective:null;
    const tagged=settings?.profileId===TIMELINE_EXPORT_FLOAT_PROFILE_ID||effective?.profileId===TIMELINE_EXPORT_FLOAT_PROFILE_ID||
      own(value,'renderAttemptId')||own(value,'audioCheck');
    if(!tagged)return true;
    if(!id.safeParse(exportId).success||value.id!==exportId||!isTimelineExportFloatSnapshot(snapshot)||typeof isRenderRecord!=='function')return false;
    const input={projectId:value.projectId,requestId:value.requestId,expectedRevision:value.timelineRevision,
      purpose:'export',exportId,...timelineRenderDeliveryFields(snapshot)};
    return isRenderRecord(value,input)===true;
  }catch{return false;}
}
