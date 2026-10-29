import {z} from 'zod';

export const AGENT_TASK_GOAL_TYPES=['duration','timeline_format','export_parameters','clip_count','subtitle_count','shot_count','generation_completed'] as const;
export const AGENT_TASK_GOAL_LIMIT=20;
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),positive=z.number().finite().positive().max(Number.MAX_SAFE_INTEGER);
const dimensions={width:integer.min(1),height:integer.min(1),fps:positive};
const seconds=z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
/** Geometry only: codec/encoding profiles are not goal conditions in H4a. */
export const agentTaskGoalConditionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('duration'),seconds:seconds.optional(),toleranceSeconds:seconds.optional(),minSeconds:seconds.optional(),maxSeconds:seconds.optional()}).strict(),
 z.object({type:z.literal('timeline_format'),...dimensions}).strict(),
 z.object({type:z.literal('export_parameters'),width:dimensions.width.optional(),height:dimensions.height.optional(),fps:dimensions.fps.optional(),durationFrames:integer.optional()}).strict(),
 z.object({type:z.literal('clip_count'),min:integer.optional(),max:integer.optional()}).strict(),
 z.object({type:z.literal('subtitle_count'),min:integer.optional(),max:integer.optional()}).strict(),
 z.object({type:z.literal('shot_count'),min:integer.optional(),max:integer.optional()}).strict(),
 z.object({type:z.literal('generation_completed')}).strict(),
]).refine(value=>{
  if(value.type!=='duration')return true;
  if(value.seconds!==undefined)return value.minSeconds===undefined&&value.maxSeconds===undefined;
  return value.toleranceSeconds===undefined&&(value.minSeconds!==undefined||value.maxSeconds!==undefined)&&(value.minSeconds===undefined||value.maxSeconds===undefined||value.minSeconds<=value.maxSeconds);
 },{message:'Duration goals need seconds with optional tolerance, or minSeconds/maxSeconds without tolerance; minSeconds must not exceed maxSeconds.'})
 .refine(value=>value.type!=='export_parameters'||['width','height','fps','durationFrames'].some(key=>Object.hasOwn(value,key)),{message:'Export parameters need at least one geometry value.'})
 .refine(value=>{
  if(value.type!=='clip_count'&&value.type!=='subtitle_count'&&value.type!=='shot_count')return true;
  return (value.min!==undefined||value.max!==undefined)&&(value.min===undefined||value.max===undefined||value.min<=value.max);
 },{message:'Count goals need min or max, and min must not exceed max.'});
export const agentTaskGoalsSchema=z.object({conditions:z.array(agentTaskGoalConditionSchema).max(AGENT_TASK_GOAL_LIMIT)}).strict();
export type AgentTaskGoalCondition=z.infer<typeof agentTaskGoalConditionSchema>;
export type AgentTaskGoals=z.infer<typeof agentTaskGoalsSchema>;
