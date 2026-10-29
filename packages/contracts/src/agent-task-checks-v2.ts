import {z} from 'zod';
import {AGENT_TASK_GOAL_TYPES,AGENT_TASK_GOAL_LIMIT} from './agent-task-goals-v2.ts';

export const AGENT_TASK_CHECK_GROUPS=['export_render','generation','timeline','decomposition_frames'] as const;
export const AGENT_TASK_CHECK_TYPES=['export_status','export_artifact','export_parameters','generation_status','generation_publication','generation_cost','timeline_references','timeline_preflight','decomposition_status','frame_status'] as const;
export const AGENT_TASK_CHECK_STATUSES=['passed','failed','pending','not_applicable'] as const;
export const AGENT_TASK_CHECK_TARGET_KINDS=['project','shot','asset','version','job','export','image_task','image_group','image_version','frame_task','scene_task','timeline','step','run'] as const;
export const AGENT_TASK_CHECK_REASONS=['TASK_PENDING','TASK_FAILED','TASK_CANCELLED','TASK_INTERRUPTED','RESULT_UNKNOWN','RECORD_UNAVAILABLE','ARTIFACT_UNAVAILABLE','PARAMETERS_MISMATCH','VERSION_UNPUBLISHED','COST_UNKNOWN','COST_PENDING','COST_SUBMITTED','REFERENCES_UNAVAILABLE','PREFLIGHT_NOT_REQUESTED','PREFLIGHT_BLOCKED','PREFLIGHT_INCOMPLETE','PREFLIGHT_STALE','PREFLIGHT_UNAVAILABLE','NOT_CHANGED','NO_APPLICABLE_TASK'] as const;

const id=z.string().uuid(),integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const agentTaskChecksInputSchema=z.object({projectId:id,runId:id,preflight:z.boolean().optional()}).strict();
const targetKind=z.enum(AGENT_TASK_CHECK_TARGET_KINDS);
const target=z.object({kind:targetKind,id,name:z.string().min(1).max(80).optional()}).strict();
const basis=z.object({kind:targetKind,id,revision:integer}).strict();
/** Bounded machine values only. Raw provider errors, paths and prose do not belong in checks. */
export const agentTaskCheckValuesSchema=z.object({
 width:integer.optional(),height:integer.optional(),fps:z.number().finite().positive().optional(),
 durationFrames:integer.optional(),durationSeconds:z.number().finite().min(0).optional(),
 toleranceSeconds:z.number().finite().min(0).optional(),min:integer.optional(),max:integer.optional(),count:integer.optional(),completedCount:integer.optional(),
 versionId:id.optional(),assetId:id.optional(),available:z.boolean().optional(),
 blockingCount:integer.optional(),missingCount:integer.optional(),referenceCount:integer.optional(),
 cost:z.enum(['pending','submitted','unknown','charged','not_applicable']).optional(),
 status:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u).optional(),
 issueCodes:z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u)).max(128).optional(),
}).strict();
export const agentTaskCheckSchema=z.object({
 id:z.string().min(1).max(240),type:z.enum(AGENT_TASK_CHECK_TYPES),source:z.literal('host'),
 status:z.enum(AGENT_TASK_CHECK_STATUSES),target,basis:z.array(basis).min(1).max(2000),
 reason:z.object({code:z.enum(AGENT_TASK_CHECK_REASONS),params:agentTaskCheckValuesSchema.optional()}).strict().optional(),
 progress:z.number().finite().min(0).max(100).optional(),
 expected:agentTaskCheckValuesSchema.optional(),current:agentTaskCheckValuesSchema.optional(),
}).strict().refine(value=>value.basis.some(item=>item.kind===value.target.kind&&item.id===value.target.id),{message:'Check target must have a revision basis.'})
 .refine(value=>new Set(value.basis.map(item=>`${item.kind}:${item.id}`)).size===value.basis.length,{message:'Duplicate check revision basis.'});
/** H4a requirements are additive; existing host groups retain their identity. */
export const agentTaskRequirementSchema=z.object({
 id:z.string().min(1).max(240),type:z.enum(AGENT_TASK_GOAL_TYPES),source:z.literal('goal'),goalStepId:id,
 status:z.enum(AGENT_TASK_CHECK_STATUSES),target,basis:z.array(basis).min(1).max(2000),
 reason:z.object({code:z.enum(AGENT_TASK_CHECK_REASONS),params:agentTaskCheckValuesSchema.optional()}).strict().optional(),
 expected:agentTaskCheckValuesSchema,current:agentTaskCheckValuesSchema,
}).strict().refine(value=>value.basis.some(item=>item.kind===value.target.kind&&item.id===value.target.id),{message:'Requirement target must have a revision basis.'})
 .refine(value=>new Set(value.basis.map(item=>`${item.kind}:${item.id}`)).size===value.basis.length,{message:'Duplicate requirement revision basis.'});
export const agentTaskChecksSchema=z.object({
 projectId:id,runId:id,runRevision:integer,
 groups:z.array(z.object({id:z.enum(AGENT_TASK_CHECK_GROUPS),items:z.array(agentTaskCheckSchema).max(2000)}).strict()).length(4),
 requirements:z.array(agentTaskRequirementSchema).max(AGENT_TASK_GOAL_LIMIT).optional(),
}).strict().refine(value=>value.groups.every((group,index)=>group.id===AGENT_TASK_CHECK_GROUPS[index]),{message:'Check groups must have canonical order.'})
 .refine(value=>{const ids=value.groups.flatMap(group=>group.items.map(item=>item.id));return new Set(ids).size===ids.length;},{message:'Duplicate check identity.'})
 .refine(value=>{const ids=value.requirements?.map(item=>item.id)??[];return new Set(ids).size===ids.length;},{message:'Duplicate requirement identity.'});

export type AgentTaskCheckValues=z.infer<typeof agentTaskCheckValuesSchema>;
export type AgentTaskRequirement=z.infer<typeof agentTaskRequirementSchema>;
export type AgentTaskCheck=z.infer<typeof agentTaskCheckSchema>;
export type AgentTaskChecks=z.infer<typeof agentTaskChecksSchema>;
export type AgentTaskChecksInput=z.infer<typeof agentTaskChecksInputSchema>;
export type AgentTaskCheckGroup=typeof AGENT_TASK_CHECK_GROUPS[number];
export type AgentTaskCheckReason=typeof AGENT_TASK_CHECK_REASONS[number];
