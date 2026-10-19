type Rec = Record<string, unknown>;
import {isVolumeEnvelopeProcessingSnapshot} from './timeline-volume-envelope-processing.ts';
import {isTimelineAudioRoleSnapshot} from './timeline-audio-role.ts';
import {isTimelineColourPlanSnapshot} from './timeline-colour.ts';
import {isTimelineExportRangeSnapshot} from './timeline-export-range.ts';
import {isTimelineDeliveryNameSnapshot} from './timeline-delivery.ts';
import {z} from 'zod';
import {timelineOutputPreset} from './timeline-format.ts';
import {TIMELINE_OUTPUT_PRESETS,timelineDeliveryGeometry} from './timeline-output-geometry.ts';
import {TIMELINE_EXPORT_FLOAT_PROFILE_ID,timelineExportFloatSettingsSchema,timelineExportFloatDeliverySchema,resolveTimelineExportFloatDelivery} from './timeline-export-float.ts';
export * from './timeline-export-float.ts';

// Immutable, closed delivery profile. Editing geometry and the 30fps clock are
// independent. Omission remains the old render path; no parser inserts defaults.
export const TIMELINE_EXPORT_PROFILE_ID='mp4_h264_v1';
export const TIMELINE_EXPORT_DEFAULT_SETTINGS=Object.freeze({profileId:TIMELINE_EXPORT_PROFILE_ID,resolution:'native',rateControl:Object.freeze({mode:'crf',quality:'standard'})});
const bitrate=z.union([z.literal(2000),z.literal(4000),z.literal(8000)]);
const timelineExportV1SettingsSchema=z.object({
 profileId:z.literal(TIMELINE_EXPORT_PROFILE_ID),resolution:z.enum(['native','short_360','short_720','short_1080']),
 rateControl:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('crf'),quality:z.enum(['compact','standard','high'])}).strict(),
  z.object({mode:z.literal('bitrate'),targetKbps:bitrate}).strict(),
 ]),
}).strict();
export const timelineExportSettingsSchema=z.discriminatedUnion('profileId',[timelineExportV1SettingsSchema,timelineExportFloatSettingsSchema]);
const effectiveSchema=z.object({
 profileId:z.literal(TIMELINE_EXPORT_PROFILE_ID),container:z.literal('mp4'),
 width:z.number().int().min(2).max(1920).multipleOf(2),height:z.number().int().min(2).max(1920).multipleOf(2),fps:z.literal(30),
 videoCodec:z.literal('libx264'),pixelFormat:z.literal('yuv420p'),preset:z.literal('veryfast'),
 rateControl:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('crf'),crf:z.union([z.literal(28),z.literal(23),z.literal(18)])}).strict(),
  z.object({mode:z.literal('bitrate'),targetKbps:bitrate}).strict(),
 ]),
 bFrames:z.literal(0),gopFrames:z.literal(60),videoTrackTimescale:z.literal(30000),scaling:z.literal('lanczos'),
 audioCodec:z.literal('aac'),audioKbps:z.literal(128),audioSampleRate:z.literal(48000),audioChannels:z.literal(2),movflags:z.literal('faststart'),
}).strict();
export type TimelineExportSettings = z.infer<typeof timelineExportSettingsSchema>;
export type TimelineExportDelivery = z.infer<typeof timelineExportDeliverySchema>;
const object=(value: unknown): value is Rec=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a: unknown,b: unknown): boolean=>object(a)&&object(b)?Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&same(a[key],b[key])):a===b;
function invalid(): never{throw Object.assign(Error('Invalid timeline export delivery profile'),{code:'INVALID_TIMELINE_SNAPSHOT'});}
export function resolveTimelineExportDelivery(timeline: unknown,exportSettings: unknown): TimelineExportDelivery {
 if(!timelineOutputPreset(timeline)||!timelineExportSettingsSchema.safeParse(exportSettings).success)invalid();
 const settings = exportSettings as TimelineExportSettings;
 if(settings.profileId===TIMELINE_EXPORT_FLOAT_PROFILE_ID)return resolveTimelineExportFloatDelivery(timeline,settings);
 const geometry=timelineDeliveryGeometry(timeline,settings.resolution);
 if(!geometry)invalid();
 const rate=settings.rateControl;
 return {exportSettings:JSON.parse(JSON.stringify(settings)),effective:{
  profileId:TIMELINE_EXPORT_PROFILE_ID,container:'mp4',width:geometry.width,height:geometry.height,fps:30,
  videoCodec:'libx264',pixelFormat:'yuv420p',preset:'veryfast',
  rateControl:rate.mode==='crf'?{mode:'crf',crf:({compact:28,standard:23,high:18} as Record<string,number>)[rate.quality]}:{mode:'bitrate',targetKbps:rate.targetKbps},
  bFrames:0,gopFrames:60,videoTrackTimescale:30000,scaling:'lanczos',audioCodec:'aac',audioKbps:128,audioSampleRate:48000,audioChannels:2,movflags:'faststart',
 }} as TimelineExportDelivery;
}
export const timelineExportDeliverySchema=z.union([z.object({exportSettings:timelineExportV1SettingsSchema,effective:effectiveSchema}).strict(),timelineExportFloatDeliverySchema]);
export function isTimelineExportDelivery(delivery: unknown,timeline: unknown,exportSettings?: unknown): boolean {
 if(!timelineExportDeliverySchema.safeParse(delivery).success||!timelineOutputPreset(timeline))return false;
 const parsed = delivery as TimelineExportDelivery;
 if(exportSettings!==undefined&&!same(parsed.exportSettings,exportSettings))return false;
 return same(parsed,resolveTimelineExportDelivery(timeline,parsed.exportSettings));
}
// Passing an exportSettings key (including undefined) binds its exact presence.
// Workers omit that option and validate the frozen deterministic profile alone.
export function isTimelineExportSnapshot(snapshot: unknown, options: unknown = {}): boolean {
 if(!object(snapshot)||!isVolumeEnvelopeProcessingSnapshot(snapshot)||!isTimelineAudioRoleSnapshot(snapshot)||!isTimelineColourPlanSnapshot(snapshot)||!isTimelineDeliveryNameSnapshot(snapshot,options as {purpose?: unknown; input?: unknown})||!isTimelineExportRangeSnapshot(snapshot,options as {purpose?: unknown; input?: unknown}))return false;
 const record = snapshot as Rec, settings = options as Rec;
 const present=Object.hasOwn(record,'delivery');
 if(Object.hasOwn(settings,'exportSettings')&&(settings.exportSettings!==undefined)!==present)return false;
 if(!present)return true;
 return (!Object.hasOwn(settings,'purpose')||settings.purpose==='export')&&isTimelineExportDelivery(record.delivery,record.timeline,settings.exportSettings);
}

export const TIMELINE_EXPORT_CAPABILITY_CODES=Object.freeze([
 'EXPORT_CAPABILITY_AVAILABLE','EXPORT_CAPABILITY_TOOL_UNAVAILABLE','EXPORT_CAPABILITY_UNSUPPORTED',
 'EXPORT_CAPABILITY_BUSY','EXPORT_CAPABILITY_TIMEOUT','EXPORT_CAPABILITY_CANCELLED','EXPORT_CAPABILITY_CONFIGURATION',
 'EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED','EXPORT_CAPABILITY_FAILED','EXPORT_CAPABILITY_OUTPUT_LIMIT',
]);
export const TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES=Object.freeze(['EXPORT_CAPABILITY_STALE',...TIMELINE_EXPORT_CAPABILITY_CODES.filter(code=>!['EXPORT_CAPABILITY_AVAILABLE','EXPORT_CAPABILITY_CANCELLED','EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED'].includes(code))]);
const capabilityStatus=(code: string): 'available'|'unavailable'|'incomplete'=>code==='EXPORT_CAPABILITY_AVAILABLE'?'available':['EXPORT_CAPABILITY_TOOL_UNAVAILABLE','EXPORT_CAPABILITY_UNSUPPORTED'].includes(code)?'unavailable':'incomplete';
export const timelineExportCapabilityResultSchema=z.object({status:z.enum(['available','unavailable','incomplete']),code:z.enum(TIMELINE_EXPORT_CAPABILITY_CODES as unknown as [string, ...string[]])}).strict().refine(value=>value.status===capabilityStatus(value.code),{message:'Capability status must match its bounded proof result'});
export const timelineExportCapabilitySchemas=Object.freeze({
 'timeline.export.capabilities':z.object({projectId:z.string().uuid(),expectedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),exportSettings:timelineExportSettingsSchema}).strict(),
});
const issueCode=z.enum([...TIMELINE_EXPORT_CAPABILITY_CODES,'TIMELINE_MISSING','INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE','EXPORT_CAPABILITY_STALE'] as unknown as [string, ...string[]]);
export const timelineExportCapabilitiesResponseSchema=z.object({
 projectId:z.string().uuid(),timelineId:z.string().uuid().nullable(),timelineRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
 expectedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),exportSettings:timelineExportSettingsSchema,delivery:timelineExportDeliverySchema.nullable(),
 checkedAt:z.string().datetime(),status:z.enum(['available','unavailable','incomplete','stale','blocked']),
 issues:z.array(z.object({code:issueCode,message:z.string().min(1).max(240)}).strict()).max(1),
}).strict().superRefine((value,context)=>{
 const fail=()=>context.addIssue({code:'custom',message:'Invalid project-bound capability report'});
 if((value.timelineId===null)!==(value.timelineRevision===null))fail();
 if(value.delivery){
  // A downscaled report cannot distinguish a 720 from a 1080 source. Require
  // an exact delivery from one supported native preset instead of guessing it.
  if(!TIMELINE_OUTPUT_PRESETS.some(timeline=>isTimelineExportDelivery(value.delivery,timeline,value.exportSettings))||value.timelineId===null)fail();
 }
 if(['available','unavailable','incomplete'].includes(value.status)){
  if(!value.delivery||value.timelineId===null||value.timelineRevision!==value.expectedRevision)fail();
  if(value.status==='available'?value.issues.length!==0:value.issues.length!==1||!timelineExportCapabilityResultSchema.safeParse({status:value.status,code:value.issues[0]?.code}).success)fail();
 }else if(value.issues.length!==1||!['TIMELINE_MISSING','INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE','EXPORT_CAPABILITY_STALE'].includes(value.issues[0]?.code))fail();
});
export type TimelineExportCapabilitiesResponse = z.infer<typeof timelineExportCapabilitiesResponseSchema>;
export function isTimelineExportCapabilitiesResponse(value: unknown, input?: unknown): boolean {
 if(!timelineExportCapabilitiesResponseSchema.safeParse(value).success)return false;
 if(!input)return true;
 const request = input as Rec, response = value as TimelineExportCapabilitiesResponse;
 return response.projectId===request.projectId&&response.expectedRevision===request.expectedRevision&&same(response.exportSettings,request.exportSettings);
}
