import {z} from 'zod';

export const AGENT_TASK_TIERS=Object.freeze(['read_only','local_reversible','local_irreversible','paid'] as const);
export const AGENT_TASK_STATUSES=Object.freeze(['accepted','running','paused','awaiting_approval','completed','failed','stopped','interrupted','reverted'] as const);
export const AGENT_TASK_STEP_STATUSES=Object.freeze(['intent','awaiting_approval','dispatch_started','completed','denied','rejected','failed','unknown'] as const);
export type AgentTaskTier=typeof AGENT_TASK_TIERS[number];
export type AgentTaskStatus=typeof AGENT_TASK_STATUSES[number];
export type AgentTaskStepStatus=typeof AGENT_TASK_STEP_STATUSES[number];
export type AgentTaskMode='direct'|'confirm';
export interface AgentTaskDiagnostic {profile:'text'|'read_only'|'catalog';toolNames?:string[]}
export type AgentTaskJson=null|boolean|number|string|AgentTaskJson[]|{[key:string]:AgentTaskJson};
export interface AgentTaskPolicy {revision:number;stepLimit:number;modes:Record<AgentTaskTier,AgentTaskMode>}
export interface AgentTaskTarget {kind:string;id:string;revision:number;revisionBefore?:number;revisionAfter?:number}
export interface AgentTaskToolCall {id:string;name:string;arguments:AgentTaskJson}
export interface AgentTaskRun {id:string;projectId:string;requestId:string;text:string;status:AgentTaskStatus;revision:number;stepLimit:number;budget:number;stepsUsed:number;configuration:AgentTaskJson;settingsRevision?:number;context?:AgentTaskJson[];attachments?:string[];diagnostic?:AgentTaskDiagnostic;createdAt:string;updatedAt:string;pauseReason?:string;error?:{code:string;message:string}}
export interface AgentTaskStep {id:string;runId:string;position:number;kind:'model'|'tool'|'wait';status:AgentTaskStepStatus;createdAt:string;updatedAt:string;request?:AgentTaskJson;data?:AgentTaskJson;toolCall?:AgentTaskToolCall;targets?:AgentTaskTarget[];tier?:AgentTaskTier;result?:AgentTaskJson;error?:{code:string;message:string};text?:string;approvalRequired?:boolean;cost?:'pending'|'submitted'|'unknown'|'charged'}
export interface AgentTaskChange {id:string;runId:string;stepId:string;projectId:string;operation:string;targets:AgentTaskTarget[];before:AgentTaskJson;after:AgentTaskJson;reversible:boolean;status:'applied'|'reverted'|'superseded';createdAt:string;revertedAt?:string;revertedTargets?:AgentTaskTarget[];undo?:AgentTaskJson;summary?:string}
export interface AgentTaskEvent {runId:string;sequence:number;type:string;data:AgentTaskJson;createdAt:string}
export interface AgentTaskSnapshot {run:AgentTaskRun;steps:AgentTaskStep[];changes:AgentTaskChange[];backgroundPending?:boolean}
export interface AgentTaskHistoryPage {runs:AgentTaskRun[];nextCursor:string|null}
export interface AgentTaskReceipt {requestId:string;runId:string;action:string;revision:number;result:AgentTaskJson}
export interface AgentTaskClaim {id:string;projectId:string;ownerId:string;target:AgentTaskTarget;state:'active'|'uncertain';createdAt:string;updatedAt:string}
const id=z.string().uuid(),requestId=z.string().min(8).max(200),revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const agentTaskTierSchema=z.enum(AGENT_TASK_TIERS);
export const agentTaskPolicySchema=z.object({revision,stepLimit:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),modes:z.object({read_only:z.enum(['direct','confirm']),local_reversible:z.enum(['direct','confirm']),local_irreversible:z.enum(['direct','confirm']),paid:z.enum(['direct','confirm'])}).strict()}).strict();
export const agentTaskDiagnosticSchema=z.object({profile:z.enum(['text','read_only','catalog']),toolNames:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)).min(1).max(200).optional()}).strict().refine(value=>value.toolNames===undefined||value.profile==='catalog'&&new Set(value.toolNames).size===value.toolNames.length,{message:'Only catalog diagnostics may select a unique tool subset.'});
export const agentTaskSendSchema=z.object({requestId,projectId:id,expectedSettingsRevision:revision,text:z.string().min(1).max(32*1024).refine(value=>value.trim().length>0&&new TextEncoder().encode(value).length<=32*1024,{message:'Task text must contain 1–32768 UTF-8 bytes.'}),uploads:z.array(id).max(20).optional(),diagnostic:agentTaskDiagnosticSchema.optional()}).strict();
export const agentTaskControlSchema=z.object({requestId,runId:id,expectedRevision:revision,action:z.enum(['pause','resume','stop','approve','deny','undo_change','undo_all','resolve_unknown']),stepId:id.optional(),changeId:id.optional(),resolution:z.enum(['discard','accept_result']).optional()}).strict();
export const agentTaskClaimSchema=z.object({requestId,projectId:id,ownerId:requestId,kind:z.string().min(1).max(80),targetId:z.string().min(1).max(200),expectedRevision:revision}).strict();
export const DEFAULT_AGENT_TASK_POLICY:Readonly<AgentTaskPolicy>=Object.freeze({revision:0,stepLimit:30,modes:Object.freeze({read_only:'direct',local_reversible:'direct',local_irreversible:'direct',paid:'confirm'})});

export type AgentTaskSendInput=z.infer<typeof agentTaskSendSchema>;
export type AgentTaskControlInput=z.infer<typeof agentTaskControlSchema>;
export type AgentTaskControlAction=AgentTaskControlInput['action'];

export const agentTaskEditingSchema=z.object({requestId,action:z.enum(['claim','restore','release','heartbeat','resolve']),projectId:id,ownerId:requestId,generation:revision,sequence:revision,targets:z.array(z.object({kind:z.string().min(1).max(80),id:z.string().min(1).max(200),revision}).strict()).min(1).max(100)}).strict();
export type AgentTaskEditingInput=z.infer<typeof agentTaskEditingSchema>;
const json:z.ZodType<AgentTaskJson>=z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(json),z.record(json)]));
const error=z.object({code:z.string(),message:z.string()}).strict();
export const agentTaskTargetSchema=z.object({kind:z.string(),id:z.string(),revision,revisionBefore:revision.optional(),revisionAfter:revision.optional()}).strict();
export const agentTaskRunSchema:z.ZodType<AgentTaskRun>=z.object({id,projectId:id,requestId,text:z.string(),status:z.enum(AGENT_TASK_STATUSES),revision,stepLimit:revision,budget:revision,stepsUsed:revision,configuration:json,settingsRevision:revision.optional(),context:z.array(json).optional(),attachments:z.array(id).max(20).optional(),diagnostic:agentTaskDiagnosticSchema.optional(),createdAt:z.string(),updatedAt:z.string(),pauseReason:z.string().optional(),error:error.optional()}).strict();
export const agentTaskStepSchema:z.ZodType<AgentTaskStep>=z.object({id,runId:id,position:revision,kind:z.enum(['model','tool','wait']),status:z.enum(AGENT_TASK_STEP_STATUSES),createdAt:z.string(),updatedAt:z.string(),request:json.optional(),data:json.optional(),toolCall:z.object({id:z.string(),name:z.string(),arguments:json}).strict().optional(),targets:z.array(agentTaskTargetSchema).optional(),tier:agentTaskTierSchema.optional(),result:json.optional(),error:error.optional(),text:z.string().optional(),approvalRequired:z.boolean().optional(),cost:z.enum(['pending','submitted','unknown','charged']).optional()}).strict();
export const agentTaskChangeSchema:z.ZodType<AgentTaskChange>=z.object({id,runId:id,stepId:id,projectId:id,operation:z.string(),targets:z.array(agentTaskTargetSchema),before:json,after:json,reversible:z.boolean(),status:z.enum(['applied','reverted','superseded']),createdAt:z.string(),revertedAt:z.string().optional(),revertedTargets:z.array(agentTaskTargetSchema).optional(),undo:json.optional(),summary:z.string().optional()}).strict();
export const agentTaskSnapshotSchema:z.ZodType<AgentTaskSnapshot>=z.object({run:agentTaskRunSchema,steps:z.array(agentTaskStepSchema),changes:z.array(agentTaskChangeSchema),backgroundPending:z.boolean().optional()}).strict();
export const agentTaskEventSchema:z.ZodType<AgentTaskEvent>=z.object({runId:id,sequence:revision,type:z.string(),data:json,createdAt:z.string()}).strict();
export const agentTaskReceiptSchema:z.ZodType<AgentTaskReceipt>=z.object({requestId,runId:id,action:z.string(),revision,result:json}).strict();

export const agentTaskHistoryPageSchema:z.ZodType<AgentTaskHistoryPage>=z.object({runs:z.array(agentTaskRunSchema),nextCursor:z.string().max(512).nullable()}).strict();
