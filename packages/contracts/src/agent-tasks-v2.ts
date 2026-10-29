import {z} from 'zod';

export const AGENT_TASK_TIERS=Object.freeze(['read_only','local_reversible','local_irreversible','paid'] as const);
export const AGENT_TASK_STATUSES=Object.freeze(['accepted','running','paused','awaiting_approval','completed','failed','stopped','interrupted','reverted','awaiting_answer'] as const);
export const AGENT_TASK_STEP_STATUSES=Object.freeze(['intent','awaiting_approval','dispatch_started','completed','denied','rejected','failed','unknown','awaiting_answer'] as const);
export const AGENT_TASK_LOCALES=Object.freeze(['zh-Hans','zh-Hant','en','ja'] as const);
export const DEFAULT_AGENT_TASK_LOCALE='zh-Hans' as const;
export type AgentTaskTier=typeof AGENT_TASK_TIERS[number];
export type AgentTaskStatus=typeof AGENT_TASK_STATUSES[number];
export type AgentTaskStepStatus=typeof AGENT_TASK_STEP_STATUSES[number];
export type AgentTaskLocale=typeof AGENT_TASK_LOCALES[number];
export type AgentTaskMode='direct'|'confirm';
/** Read-only presentation values. These never grant tool or undo authority. */
export const AGENT_TASK_DISPLAY_PROPERTIES=Object.freeze(['durationFrames','sourceInFrame','sourceOutFrame','startFrame','positionX','positionY','gainDb','fadeInFrames','fadeOutFrames','aspectRatio','durationSeconds','description','subtitleText','provider','model','mode','versionNumber','resolution','generateAudio','seed','width','height','count','quality','outputFormat','background'] as const);
export const AGENT_TASK_DISPLAY_TARGET_KINDS=Object.freeze(['project','shot','node','edge','asset','version','job','export','asset_range','asset_disposition','asset_annotation','subject','subject_version','subject_binding','image_task','image_group','image_version','frame_task','timeline','timeline_clip','timeline_track','timeline_subtitle','unknown'] as const);
export type AgentTaskDisplayValue=number|string|boolean|null;
export interface AgentTaskDisplayTarget {kind:typeof AGENT_TASK_DISPLAY_TARGET_KINDS[number];id:string;name?:string}
export interface AgentTaskDisplayField {targetIndex?:number;property:typeof AGENT_TASK_DISPLAY_PROPERTIES[number];unit:'frames'|'seconds'|'db'|'pixels'|'ratio'|'text'|'count'|'boolean'|'enum';before?:AgentTaskDisplayValue;after?:AgentTaskDisplayValue;current?:AgentTaskDisplayValue}
export interface AgentTaskDisplay {conflict?:true;operation:string;targets:AgentTaskDisplayTarget[];targetCount:number;fields:AgentTaskDisplayField[]}
export interface AgentTaskDiagnostic {profile:'text'|'read_only'|'catalog';toolNames?:string[]}
export type AgentTaskJson=null|boolean|number|string|AgentTaskJson[]|{[key:string]:AgentTaskJson};
export interface AgentTaskPolicy {revision:number;stepLimit:number;modes:Record<AgentTaskTier,AgentTaskMode>}
export interface AgentTaskTarget {kind:string;id:string;revision:number;revisionBefore?:number;revisionAfter?:number}
export interface AgentTaskNote {requestId:string;text:string;createdAt:string;modelStepId?:string}
export interface AgentTaskSkippedTarget {target:AgentTaskTarget;stepId:string;createdAt:string}
export interface AgentTaskToolCall {id:string;name:string;arguments:AgentTaskJson}
export interface AgentTaskRun {id:string;projectId:string;conversationId?:string;requestId:string;text:string;notes?:AgentTaskNote[];skippedTargets?:AgentTaskSkippedTarget[];status:AgentTaskStatus;revision:number;stepLimit:number;budget:number;stepsUsed:number;configuration:AgentTaskJson;settingsRevision?:number;context?:AgentTaskJson[];attachments?:string[];diagnostic?:AgentTaskDiagnostic;createdAt:string;updatedAt:string;pauseReason?:string;error?:{code:string;message:string}}
export interface AgentTaskStep {id:string;runId:string;position:number;kind:'model'|'tool'|'wait';status:AgentTaskStepStatus;createdAt:string;updatedAt:string;request?:AgentTaskJson;data?:AgentTaskJson;toolCall?:AgentTaskToolCall;targets?:AgentTaskTarget[];tier?:AgentTaskTier;result?:AgentTaskJson;error?:{code:string;message:string};text?:string;approvalRequired?:boolean;cost?:'pending'|'submitted'|'unknown'|'charged';display?:AgentTaskDisplay;repair?:{sourceModelStepId:string}}
export interface AgentTaskChange {id:string;runId:string;stepId:string;projectId:string;operation:string;targets:AgentTaskTarget[];before:AgentTaskJson;after:AgentTaskJson;reversible:boolean;status:'applied'|'reverted'|'superseded';createdAt:string;revertedAt?:string;revertedTargets?:AgentTaskTarget[];undo?:AgentTaskJson;summary?:string;display?:AgentTaskDisplay;modifiedAfter?:boolean;undoDisposition?:'undo'|'retain'|'blocked'}
export interface AgentTaskEvent {runId:string;sequence:number;type:string;data:AgentTaskJson;createdAt:string}
export interface AgentTaskSnapshot {run:AgentTaskRun;steps:AgentTaskStep[];changes:AgentTaskChange[];backgroundPending?:boolean;executionEndedAt?:string}
export interface AgentTaskConversation {id:string;projectId:string;title:string;createdAt:string;updatedAt:string;lastRunId:string;lastRunStatus:AgentTaskStatus;changeCount:number;runCount:number}
export interface AgentTaskHistoryPage {conversations:AgentTaskConversation[];nextCursor:string|null}
export interface AgentTaskConversationPage {conversation:AgentTaskConversation;runs:AgentTaskRun[];nextCursor:string|null}
export interface AgentTaskReceipt {requestId:string;runId:string;action:string;revision:number;result:AgentTaskJson}
export interface AgentTaskClaim {id:string;projectId:string;ownerId:string;target:AgentTaskTarget;state:'active'|'uncertain';createdAt:string;updatedAt:string}
const id=z.string().uuid(),requestId=z.string().min(8).max(200),revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const agentTaskTierSchema=z.enum(AGENT_TASK_TIERS);
export const agentTaskLocaleSchema=z.enum(AGENT_TASK_LOCALES);
export const agentTaskPolicyModesSchema=z.object({read_only:z.enum(['direct','confirm']),local_reversible:z.enum(['direct','confirm']),local_irreversible:z.enum(['direct','confirm']),paid:z.enum(['direct','confirm'])}).strict();
export const agentTaskPolicySchema=z.object({revision,stepLimit:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),modes:agentTaskPolicyModesSchema}).strict();
export const agentTaskDiagnosticSchema=z.object({profile:z.enum(['text','read_only','catalog']),toolNames:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)).min(1).max(200).optional()}).strict().refine(value=>value.toolNames===undefined||value.profile==='catalog'&&new Set(value.toolNames).size===value.toolNames.length,{message:'Only catalog diagnostics may select a unique tool subset.'});
export const agentTaskTextSchema=z.string().min(1).max(32*1024).refine(value=>value.trim().length>0&&new TextEncoder().encode(value).length<=32*1024,{message:'Task text must contain 1–32768 UTF-8 bytes.'});
/** Mio's structured question (C3), asked through the host tool `mioon_ask`.
 * The answer is the user's own input to the model, never an approval. */
export const AGENT_TASK_QUESTION_LIMITS=Object.freeze({question:200,minOptions:2,options:4,label:60,description:80,answer:2000});
const singleLine=(max:number)=>z.string().refine(value=>value.trim().length>0&&[...value].length<=max&&!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value),{message:`Text must be 1-${max} characters on one line`});
export interface AgentTaskQuestionOption {label:string;description?:string}
export interface AgentTaskQuestion {question:string;options:AgentTaskQuestionOption[];multiple?:boolean;allowOther?:boolean}
export interface AgentTaskAnswer {choices:number[];text?:string}
export const agentTaskQuestionOptionSchema:z.ZodType<AgentTaskQuestionOption>=z.object({label:singleLine(AGENT_TASK_QUESTION_LIMITS.label),description:singleLine(AGENT_TASK_QUESTION_LIMITS.description).optional()}).strict();
export const agentTaskQuestionSchema:z.ZodType<AgentTaskQuestion>=z.object({question:singleLine(AGENT_TASK_QUESTION_LIMITS.question),
 options:z.array(agentTaskQuestionOptionSchema).min(AGENT_TASK_QUESTION_LIMITS.minOptions).max(AGENT_TASK_QUESTION_LIMITS.options).refine(values=>new Set(values.map(value=>value.label.trim())).size===values.length,{message:'Option labels must be distinct'}),
 multiple:z.boolean().optional(),allowOther:z.boolean().optional()}).strict();
/** Built-in method documents Mio reads with `mioon_skill_read` (C6). */
export const AGENT_TASK_SKILL_NAMES=Object.freeze(['script-to-shots','shot-prompts','character-consistency','continuity-check'] as const);
export type AgentTaskSkillName=typeof AGENT_TASK_SKILL_NAMES[number];
/** A read-only continuity review (C6) reported through `mioon_continuity_report`.
 * It names shots and what may not match; it never changes them. */
export const AGENT_TASK_CONTINUITY_CATEGORIES=Object.freeze(['wardrobe','props','injury','position','direction','eyeline','lighting','sound','other'] as const);
export type AgentTaskContinuityCategory=typeof AGENT_TASK_CONTINUITY_CATEGORIES[number];
export const AGENT_TASK_CONTINUITY_LIMITS=Object.freeze({issues:20,shots:4,text:200});
export interface AgentTaskContinuityIssue {category:AgentTaskContinuityCategory;shotIds:string[];text:string}
export interface AgentTaskContinuityReport {issues:AgentTaskContinuityIssue[]}
export const agentTaskContinuityIssueSchema:z.ZodType<AgentTaskContinuityIssue>=z.object({category:z.enum(AGENT_TASK_CONTINUITY_CATEGORIES),
 shotIds:z.array(id).min(1).max(AGENT_TASK_CONTINUITY_LIMITS.shots).refine(values=>new Set(values.map(value=>value.toLowerCase())).size===values.length,{message:'Shot ids must be distinct'}),
 text:singleLine(AGENT_TASK_CONTINUITY_LIMITS.text)}).strict();
export const agentTaskContinuityReportSchema:z.ZodType<AgentTaskContinuityReport>=z.object({issues:z.array(agentTaskContinuityIssueSchema).max(AGENT_TASK_CONTINUITY_LIMITS.issues)}).strict();
export const agentTaskAnswerTextSchema=z.string().refine(value=>value.trim().length>0&&[...value].length<=AGENT_TASK_QUESTION_LIMITS.answer&&!/[\p{Cc}]/u.test(value.replace(/[\n\t]/gu,'')),{message:'Answer text must be 1-2000 characters'});
export const agentTaskAnswerSchema:z.ZodType<AgentTaskAnswer>=z.object({choices:z.array(z.number().int().min(0).max(AGENT_TASK_QUESTION_LIMITS.options-1)).max(AGENT_TASK_QUESTION_LIMITS.options),text:agentTaskAnswerTextSchema.optional()}).strict();
export const agentTaskSendSchema=z.object({requestId,projectId:id,conversationId:id.optional(),expectedSettingsRevision:revision,text:agentTaskTextSchema,locale:agentTaskLocaleSchema.optional(),uploads:z.array(id).max(20).optional(),diagnostic:agentTaskDiagnosticSchema.optional(),policy:z.object({modes:agentTaskPolicyModesSchema,acknowledgePaid:z.literal(true).optional()}).strict().optional()}).strict();
export const agentTaskControlBaseSchema=z.object({requestId,runId:id,expectedRevision:revision,stepId:id.optional(),changeId:id.optional(),resolution:z.enum(['discard','accept_result']).optional()}).strict();
export const agentTaskNoteControlSchema=z.object({requestId,runId:id,expectedRevision:revision,action:z.literal('note'),text:agentTaskTextSchema}).strict();
export const agentTaskUndoAllControlSchema=agentTaskControlBaseSchema.extend({action:z.literal('undo_all'),undoChangeIds:z.array(id).max(10000).refine(values=>new Set(values).size===values.length).optional()}).strict();
export const agentTaskAnswerControlObjectSchema=z.object({requestId,runId:id,expectedRevision:revision,action:z.literal('answer'),stepId:id,choices:z.array(z.number().int().min(0).max(AGENT_TASK_QUESTION_LIMITS.options-1)).max(AGENT_TASK_QUESTION_LIMITS.options).refine(values=>new Set(values).size===values.length,{message:'Choices must be distinct'}),text:agentTaskAnswerTextSchema.optional()}).strict();
export const agentTaskAnswerControlSchema=agentTaskAnswerControlObjectSchema.refine(value=>value.choices.length>0||value.text!==undefined,{message:'An answer needs a choice or text'});
export const agentTaskControlSchema=z.union([agentTaskControlBaseSchema.extend({action:z.enum(['pause','resume','retry','stop','approve','deny','skip','undo_change','resolve_unknown'])}).strict(),agentTaskUndoAllControlSchema,agentTaskNoteControlSchema,agentTaskAnswerControlSchema]);
export const agentTaskClaimSchema=z.object({requestId,projectId:id,ownerId:requestId,kind:z.string().min(1).max(80),targetId:z.string().min(1).max(200),expectedRevision:revision}).strict();
export const DEFAULT_AGENT_TASK_POLICY:Readonly<AgentTaskPolicy>=Object.freeze({revision:0,stepLimit:30,modes:Object.freeze({read_only:'direct',local_reversible:'direct',local_irreversible:'confirm',paid:'confirm'})});
/** A conversation's own confirmation modes (C1). `override` null follows the
 * global policy; the step limit always comes from the global policy. */
export type AgentTaskPolicyModes=Record<AgentTaskTier,AgentTaskMode>;
export interface AgentTaskConversationPolicy {projectId:string;conversationId:string;revision:number;override:AgentTaskPolicyModes|null;global:AgentTaskPolicy;effective:AgentTaskPolicyModes}
export const agentTaskConversationPolicySetSchema=z.object({requestId,expectedRevision:revision,modes:agentTaskPolicyModesSchema.nullable(),acknowledgePaid:z.literal(true).optional()}).strict();
export type AgentTaskConversationPolicySetInput=z.infer<typeof agentTaskConversationPolicySetSchema>;
export const agentTaskConversationPolicySchema:z.ZodType<AgentTaskConversationPolicy>=z.object({projectId:id,conversationId:id,revision,override:agentTaskPolicyModesSchema.nullable(),global:agentTaskPolicySchema,effective:agentTaskPolicyModesSchema}).strict();
/** The three presets of the composer menu; anything else is shown as custom. */
export const AGENT_TASK_POLICY_PRESETS=Object.freeze({
 step:Object.freeze({read_only:'direct',local_reversible:'confirm',local_irreversible:'confirm',paid:'confirm'}),
 default:Object.freeze({read_only:'direct',local_reversible:'direct',local_irreversible:'confirm',paid:'confirm'}),
 full:Object.freeze({read_only:'direct',local_reversible:'direct',local_irreversible:'direct',paid:'direct'}),
} as const satisfies Record<string,Readonly<AgentTaskPolicyModes>>);
export type AgentTaskPolicyPreset=keyof typeof AGENT_TASK_POLICY_PRESETS;
export function agentTaskPolicyPreset(modes:Readonly<AgentTaskPolicyModes>):AgentTaskPolicyPreset|'custom'{
 for(const [name,preset] of Object.entries(AGENT_TASK_POLICY_PRESETS) as [AgentTaskPolicyPreset,Readonly<AgentTaskPolicyModes>][])if(AGENT_TASK_TIERS.every(tier=>preset[tier]===modes[tier]))return name;
 return 'custom';
}

export type AgentTaskSendInput=z.infer<typeof agentTaskSendSchema>;
export type AgentTaskControlInput=z.infer<typeof agentTaskControlSchema>;
export type AgentTaskControlAction=AgentTaskControlInput['action'];

export const agentTaskEditingSchema=z.object({requestId,action:z.enum(['claim','restore','release','heartbeat','resolve']),projectId:id,ownerId:requestId,generation:revision,sequence:revision,targets:z.array(z.object({kind:z.string().min(1).max(80),id:z.string().min(1).max(200),revision}).strict()).min(1).max(100)}).strict();
export type AgentTaskEditingInput=z.infer<typeof agentTaskEditingSchema>;
const json:z.ZodType<AgentTaskJson>=z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(json),z.record(json)]));
const error=z.object({code:z.string(),message:z.string()}).strict();
const displayValue=z.union([z.number().finite(),z.string().max(240),z.boolean(),z.null()]);
export const agentTaskDisplaySchema:z.ZodType<AgentTaskDisplay>=z.object({conflict:z.literal(true).optional(),operation:z.string().regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/u).max(100),targets:z.array(z.object({kind:z.enum(AGENT_TASK_DISPLAY_TARGET_KINDS),id,name:z.string().min(1).max(80).optional()}).strict()).max(200),targetCount:revision,fields:z.array(z.object({targetIndex:revision.optional(),property:z.enum(AGENT_TASK_DISPLAY_PROPERTIES),unit:z.enum(['frames','seconds','db','pixels','ratio','text','count','boolean','enum']),before:displayValue.optional(),after:displayValue.optional(),current:displayValue.optional()}).strict().refine(field=>field.before!==undefined||field.after!==undefined)).max(2000)}).strict().refine(display=>display.targetCount>=display.targets.length&&display.fields.every(field=>field.targetIndex===undefined||field.targetIndex<display.targets.length));
export const agentTaskTargetSchema=z.object({kind:z.string(),id:z.string(),revision,revisionBefore:revision.optional(),revisionAfter:revision.optional()}).strict();
export const agentTaskNoteSchema:z.ZodType<AgentTaskNote>=z.object({requestId,text:agentTaskTextSchema,createdAt:z.string().datetime(),modelStepId:id.optional()}).strict();
export const agentTaskSkippedTargetSchema:z.ZodType<AgentTaskSkippedTarget>=z.object({target:agentTaskTargetSchema,stepId:id,createdAt:z.string().datetime()}).strict();
export const agentTaskRunSchema:z.ZodType<AgentTaskRun>=z.object({id,projectId:id,conversationId:id.optional(),requestId,text:z.string(),notes:z.array(agentTaskNoteSchema).optional(),skippedTargets:z.array(agentTaskSkippedTargetSchema).optional(),status:z.enum(AGENT_TASK_STATUSES),revision,stepLimit:revision,budget:revision,stepsUsed:revision,configuration:json,settingsRevision:revision.optional(),context:z.array(json).optional(),attachments:z.array(id).max(20).optional(),diagnostic:agentTaskDiagnosticSchema.optional(),createdAt:z.string(),updatedAt:z.string(),pauseReason:z.string().optional(),error:error.optional()}).strict();
export const agentTaskStepSchema:z.ZodType<AgentTaskStep>=z.object({id,runId:id,position:revision,kind:z.enum(['model','tool','wait']),status:z.enum(AGENT_TASK_STEP_STATUSES),createdAt:z.string(),updatedAt:z.string(),request:json.optional(),data:json.optional(),toolCall:z.object({id:z.string(),name:z.string(),arguments:json}).strict().optional(),targets:z.array(agentTaskTargetSchema).optional(),tier:agentTaskTierSchema.optional(),result:json.optional(),error:error.optional(),text:z.string().optional(),approvalRequired:z.boolean().optional(),cost:z.enum(['pending','submitted','unknown','charged']).optional(),display:agentTaskDisplaySchema.optional(),repair:z.object({sourceModelStepId:id}).strict().optional()}).strict();
export const agentTaskChangeSchema:z.ZodType<AgentTaskChange>=z.object({id,runId:id,stepId:id,projectId:id,operation:z.string(),targets:z.array(agentTaskTargetSchema),before:json,after:json,reversible:z.boolean(),status:z.enum(['applied','reverted','superseded']),createdAt:z.string(),revertedAt:z.string().optional(),revertedTargets:z.array(agentTaskTargetSchema).optional(),undo:json.optional(),summary:z.string().optional(),display:agentTaskDisplaySchema.optional(),modifiedAfter:z.boolean().optional(),undoDisposition:z.enum(['undo','retain','blocked']).optional()}).strict();
export const agentTaskSnapshotSchema:z.ZodType<AgentTaskSnapshot>=z.object({run:agentTaskRunSchema,steps:z.array(agentTaskStepSchema),changes:z.array(agentTaskChangeSchema),backgroundPending:z.boolean().optional(),executionEndedAt:z.string().datetime().optional()}).strict();
export const agentTaskEventSchema:z.ZodType<AgentTaskEvent>=z.object({runId:id,sequence:revision,type:z.string(),data:json,createdAt:z.string()}).strict();
export const agentTaskReceiptSchema:z.ZodType<AgentTaskReceipt>=z.object({requestId,runId:id,action:z.string(),revision,result:json}).strict();

export const agentTaskConversationSchema:z.ZodType<AgentTaskConversation>=z.object({id,projectId:id,title:z.string().min(1).max(120),createdAt:z.string(),updatedAt:z.string(),lastRunId:id,lastRunStatus:z.enum(AGENT_TASK_STATUSES),changeCount:revision,runCount:revision}).strict();
/** Latest text diagnostic in the workspace, shown as the settings page's connection test. Only identity,
 * timing and outcome are exposed; the test text, model reply and credentials never are. */
export interface AgentTaskConnectionTest {runId:string;projectId:string;status:AgentTaskStatus;createdAt:string;updatedAt:string;protocol:string;baseUrl:string;model:string;failureCode?:string}
export const agentTaskConnectionTestSchema:z.ZodType<AgentTaskConnectionTest>=z.object({runId:id,projectId:id,status:z.enum(AGENT_TASK_STATUSES),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),protocol:z.string().min(1).max(64),baseUrl:z.string().min(1).max(2048),model:z.string().min(1).max(200),failureCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u).optional()}).strict();
export const agentTaskConnectionTestResponseSchema=z.object({test:agentTaskConnectionTestSchema.nullable()}).strict();
export const agentTaskHistoryPageSchema:z.ZodType<AgentTaskHistoryPage>=z.object({conversations:z.array(agentTaskConversationSchema).max(100),nextCursor:z.string().max(512).nullable()}).strict();
export const agentTaskConversationPageSchema:z.ZodType<AgentTaskConversationPage>=z.object({conversation:agentTaskConversationSchema,runs:z.array(agentTaskRunSchema).max(100),nextCursor:z.string().max(512).nullable()}).strict();

export * from './agent-task-checks-v2.ts';
export * from './agent-task-goals-v2.ts';
