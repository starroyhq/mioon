import {timelineVolumeEnvelopeCapabilitySchema} from './timeline-volume-envelope-capability.ts';
import {timelineAudioRoleCapabilitySchema} from './timeline-audio-role.ts';
import {z} from 'zod';
import {workspaceRestoreProfile,workspaceRestoreSourceVersion,workspaceRestoreDatabaseVersion,validateWorkspaceRestorationPair} from './workspace-schema-profiles.ts';
import {isRestoredWorkspaceSchemaSince} from './workspace-schema-lineage.ts';

// This is an invocation mismatch guard, never a credential or a model-tool
// grant. It stays outside immutable domain input, request hashes and receipts.
export const WORKSPACE_RESTORE_PROFILE = 'restored-local-v1';
export const WORKSPACE_RESTORE_SCHEMA_VERSION = 25;
export const WORKSPACE_RESTORE_LIMITS = Object.freeze({capturedRecords:20_000,historyArchiveBytes:64*1024*1024,
  databaseBytes:512*1024*1024,heldKinds:64,operations:160,taskPage:50});
export const expectedWorkspaceOriginSchema = z.string().length(36).uuid();
export function parseExpectedWorkspaceOrigin(value: unknown): string | undefined {
  return value===undefined?undefined:expectedWorkspaceOriginSchema.parse(value);
}

const uuid=z.string().length(36).uuid(),hash=z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const count=z.number().int().min(0).max(WORKSPACE_RESTORE_LIMITS.capturedRecords);
const kind=z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/u);
const operation=z.string().min(1).max(80).regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/u);
export const WORKSPACE_RESTORE_REASONS=Object.freeze(['AVAILABLE','RESTORE_OPERATION_UNAVAILABLE','RESTORE_GATE_PENDING'] as const);
const policy=z.object({operation,available:z.boolean(),reason:z.enum(WORKSPACE_RESTORE_REASONS)}).strict()
  .refine(value=>value.available===(value.reason==='AVAILABLE'),{message:'Restore operation availability and reason disagree.'});
export const workspaceRestoreSchemas=Object.freeze({
  'workspace.restore.inspect':z.object({includeAudioRoleCapability:z.literal(true).optional(),includeVolumeEnvelopeCapability:z.literal(true).optional()}).strict(),
});
const restoredInspection=z.object({
  audioRoleCapability:timelineAudioRoleCapabilitySchema.optional(),
  volumeEnvelopeCapability:timelineVolumeEnvelopeCapabilitySchema.optional(),
  restored:z.literal(true),schemaVersion:workspaceRestoreDatabaseVersion,profile:workspaceRestoreProfile,
  workspaceOrigin:uuid,restorationId:uuid,createdAt:z.string().datetime(),
  source:z.object({backupId:uuid,schemaVersion:workspaceRestoreSourceVersion,manifestHash:hash,dbHash:hash}).strict(),
  heldCounts:z.array(z.object({kind,count}).strict()).max(WORKSPACE_RESTORE_LIMITS.heldKinds),
  operationPolicy:z.array(policy).max(WORKSPACE_RESTORE_LIMITS.operations),
  backupCreate:z.object({available:z.literal(false),reason:z.literal('RESTORE_BACKUP_UNAVAILABLE')}).strict(),
}).strict().superRefine((value,ctx)=>{
  // Audio roles exist from ordinary schema38 on, volume envelopes from schema40.
  if(value.audioRoleCapability&&value.audioRoleCapability.editable!==isRestoredWorkspaceSchemaSince(38,value.schemaVersion))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Audio role capability does not match the exact restored profile.'});
  if(value.volumeEnvelopeCapability&&value.volumeEnvelopeCapability.editable&&!isRestoredWorkspaceSchemaSince(40,value.schemaVersion))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Volume envelope capability requires a supported exact restored profile.'});
  validateWorkspaceRestorationPair({profile:value.profile,sourceSchema:value.source.schemaVersion,databaseSchemaVersion:value.schemaVersion},ctx);
  for(const [field,key] of [['heldCounts','kind'],['operationPolicy','operation']] as const) {
    const items = value[field] as {kind?: unknown; operation?: unknown}[];
    if(new Set(items.map(item=>item[key])).size!==items.length)
      ctx.addIssue({code:z.ZodIssueCode.custom,path:[field],message:'Restore disclosure contains duplicate identities.'});
  }
});
export const workspaceRestoreInspectionSchema=z.union([z.object({restored:z.literal(false),audioRoleCapability:timelineAudioRoleCapabilitySchema.optional(),volumeEnvelopeCapability:timelineVolumeEnvelopeCapabilitySchema.optional()}).strict(),restoredInspection]);
export type WorkspaceRestoreInspection = z.infer<typeof workspaceRestoreInspectionSchema>;
export function isWorkspaceRestoreInspection(value: unknown): value is WorkspaceRestoreInspection {return workspaceRestoreInspectionSchema.safeParse(value).success;}
/** Missing capability means an older backend, never permission to edit. */
export function canEditTimelineVolumeEnvelope(inspection: unknown): boolean {return isWorkspaceRestoreInspection(inspection)&&inspection.volumeEnvelopeCapability?.editable===true;}
export function canEditTimelineAudioRole(inspection: unknown): boolean {return isWorkspaceRestoreInspection(inspection)&&inspection.audioRoleCapability?.editable===true;}


const epoch=z.union([z.literal('captured'),uuid]);
export const workspaceRestoreTaskContextSchema=z.object({workspaceOrigin:uuid,executionEpoch:epoch,held:z.boolean()}).strict()
  .refine(value=>value.held===(value.executionEpoch!==value.workspaceOrigin),{message:'Restore task origin and held state disagree.'});
export const workspaceRestoreTaskListContextSchema=z.object({workspaceOrigin:uuid,
  tasks:z.array(z.object({taskId:uuid,executionEpoch:epoch,held:z.boolean()}).strict()).max(WORKSPACE_RESTORE_LIMITS.taskPage),
}).strict().superRefine((value,ctx)=>{
  if(new Set(value.tasks.map(item=>item.taskId)).size!==value.tasks.length)
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['tasks'],message:'Restore task identities must be unique.'});
  for(let index=0;index<value.tasks.length;index++)if(value.tasks[index].held!==(value.tasks[index].executionEpoch!==value.workspaceOrigin))
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['tasks',index,'held'],message:'Restore task origin and held state disagree.'});
});
