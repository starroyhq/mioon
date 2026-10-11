import {z} from 'zod';
// Closed timeline-output presets. Source/generation and the editing timebase
// remain independent; this module does not normalize stored legacy records.
export const TIMELINE_OUTPUT_PRESETS = Object.freeze([
  Object.freeze({id:'portrait_720',label:'竖屏 9:16',fps:30,width:720,height:1280}),
  Object.freeze({id:'landscape_720',label:'横屏 16:9',fps:30,width:1280,height:720}),
  Object.freeze({id:'square_720',label:'方屏 1:1',fps:30,width:720,height:720}),
]);
export const DEFAULT_TIMELINE_OUTPUT_PRESET = 'portrait_720';
export function timelineOutputPreset(value) {
  if (typeof value === 'string') return TIMELINE_OUTPUT_PRESETS.find(item=>item.id===value) ?? null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return TIMELINE_OUTPUT_PRESETS.find(item=>item.fps===value.fps && item.width===value.width && item.height===value.height) ?? null;
}

export const TIMELINE_FORMAT_BLOCKED_REASONS = Object.freeze(['CLIPS_PRESENT','HISTORY_PRESENT','REQUEST_HISTORY','EXPORT_HISTORY','PENDING_EDIT']);
const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const timelineFormatSchemas = Object.freeze({
  'timeline.format.get':z.object({projectId:z.string().uuid()}).strict(),
  'timeline.format.set':z.object({projectId:z.string().uuid(),expectedProjectRevision:revision,
    expectedRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),requestId:z.string().min(8).max(200),
    presetId:z.enum(TIMELINE_OUTPUT_PRESETS.map(item=>item.id))}).strict(),
});
export const timelineFormatResponseSchema=z.object({projectId:z.string().uuid(),projectRevision:revision,
  timelineId:z.string().uuid().nullable(),timelineRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  presetId:z.enum(TIMELINE_OUTPUT_PRESETS.map(item=>item.id)),fps:z.literal(30),width:z.number(),height:z.number(),
  eligible:z.boolean(),blockedReasons:z.array(z.enum(TIMELINE_FORMAT_BLOCKED_REASONS)).max(TIMELINE_FORMAT_BLOCKED_REASONS.length)
}).strict().superRefine((value,context)=>{
  if(timelineOutputPreset(value)?.id!==value.presetId || (value.timelineId===null)!==(value.timelineRevision===0) ||
     value.eligible!==(value.blockedReasons.length===0) || new Set(value.blockedReasons).size!==value.blockedReasons.length ||
     value.timelineId===null&&value.presetId!==DEFAULT_TIMELINE_OUTPUT_PRESET)
    context.addIssue({code:'custom',message:'Invalid timeline format metadata'});
});
export const isTimelineFormatResponse=value=>timelineFormatResponseSchema.safeParse(value).success;

export const isTimelineFormatReadResponse=(value,input)=>isTimelineFormatResponse(value)&&value.projectId===input?.projectId;
