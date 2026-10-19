import {z} from 'zod';
import {TIMELINE_OUTPUT_PRESETS,DEFAULT_TIMELINE_OUTPUT_PRESET,timelineOutputPreset} from './timeline-output-geometry.ts';
export {TIMELINE_OUTPUT_PRESETS,TIMELINE_CURRENT_OUTPUT_PRESETS,TIMELINE_LEGACY_OUTPUT_PRESETS,DEFAULT_TIMELINE_OUTPUT_PRESET,timelineOutputPreset} from './timeline-output-geometry.ts';
// Closed timeline-output presets. Source/generation and the editing timebase
// remain independent; this module does not normalize stored legacy records.
export const TIMELINE_FORMAT_BLOCKED_REASONS = Object.freeze(['CLIPS_PRESENT','HISTORY_PRESENT','REQUEST_HISTORY','EXPORT_HISTORY','PENDING_EDIT'] as const);
const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const timelineFormatSchemas = Object.freeze({
  'timeline.format.get':z.object({projectId:z.string().uuid()}).strict(),
  'timeline.format.set':z.object({projectId:z.string().uuid(),expectedProjectRevision:revision,
    expectedRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),requestId:z.string().min(8).max(200),
    presetId:z.enum(TIMELINE_OUTPUT_PRESETS.map(item=>item.id) as [string, ...string[]])}).strict(),
});
export const timelineFormatResponseSchema=z.object({projectId:z.string().uuid(),projectRevision:revision,
  timelineId:z.string().uuid().nullable(),timelineRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  presetId:z.enum(TIMELINE_OUTPUT_PRESETS.map(item=>item.id) as [string, ...string[]]),fps:z.literal(30),width:z.number(),height:z.number(),
  eligible:z.boolean(),blockedReasons:z.array(z.enum(TIMELINE_FORMAT_BLOCKED_REASONS)).max(TIMELINE_FORMAT_BLOCKED_REASONS.length)
}).strict().superRefine((value,context)=>{
  if(timelineOutputPreset(value)?.id!==value.presetId || (value.timelineId===null)!==(value.timelineRevision===0) ||
     value.eligible!==(value.blockedReasons.length===0) || new Set(value.blockedReasons).size!==value.blockedReasons.length ||
     value.timelineId===null&&value.presetId!==DEFAULT_TIMELINE_OUTPUT_PRESET)
    context.addIssue({code:'custom',message:'Invalid timeline format metadata'});
});
export type TimelineFormatResponse = z.infer<typeof timelineFormatResponseSchema>;
export function isTimelineFormatResponse(value: unknown): value is TimelineFormatResponse { return timelineFormatResponseSchema.safeParse(value).success; }

export function isTimelineFormatReadResponse(value: unknown, input: {projectId?: unknown} | null | undefined): boolean {
  return isTimelineFormatResponse(value) && value.projectId === input?.projectId;
}
