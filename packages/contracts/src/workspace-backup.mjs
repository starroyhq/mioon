import {z} from 'zod';

export const WORKSPACE_BACKUP_FORMAT='mioon-workspace-backup';
export const WORKSPACE_BACKUP_FORMAT_VERSION=1;
export const WORKSPACE_BACKUP_LIMITS=Object.freeze({
 databaseBytes:512*1024*1024,fileCount:20_000,fileBytes:8*1024*1024*1024,
 totalBytes:64*1024*1024*1024,manifestBytes:8*1024*1024,chunkBytes:1024*1024,issues:100,
});
export const WORKSPACE_BACKUP_ISSUE_CODES=Object.freeze([
 'MISSING_REGISTERED_MEDIA','INVALID_ASSET_RECORD','INVALID_TASK_RECORD',
 'MISSING_STAGE_MANIFEST','MISSING_RECEIPT_MEDIA','INVALID_STAGE_MANIFEST','INCONSISTENT_STAGE_RECEIPT',
 'UNRECOGNIZED_FILE_EXCLUDED','PARTIAL_RESULT_PRESERVED','UNCOMMITTED_RESULT_PRESERVED',
 'UNRESOLVED_TASK_RETAINED','REGISTERED_MEDIA_MISMATCH','RECORD_INSPECTION_LIMIT',
]);
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const media=new RegExp(`^payload/media/(?:${uuid}\\.(?:png|jpg|jpeg|webp|mp4|webm|wav|mp3|m4a)|result-${uuid}\\.mp4(?:\\.part\\.mp4)?|export-${uuid}-${uuid}\\.mp4(?:\\.part\\.mp4)?)$`,'i');
const stage=new RegExp(`^payload/(image|frame)-staging/${uuid}\\.(png|json)$`,'i');
export function isWorkspaceBackupPayloadPath(value){return typeof value==='string'&&(value==='payload/workbench.sqlite'||media.test(value)||stage.test(value));}
const payloadPath=z.string().max(240).refine(isWorkspaceBackupPayloadPath,{message:'Expected a canonical fixed backup payload path.'});
const issuePath=z.string().max(240).regex(/^payload\/(?:media|image-staging|frame-staging)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
export const workspaceBackupInventorySchema=z.object({
 complete:z.boolean(),totalIssues:integer,
 issues:z.array(z.object({code:z.enum(WORKSPACE_BACKUP_ISSUE_CODES),path:issuePath.optional()}).strict()).max(WORKSPACE_BACKUP_LIMITS.issues),
 truncated:z.boolean(),
}).strict().superRefine((value,ctx)=>{
 if(value.totalIssues<value.issues.length||value.truncated!==(value.totalIssues>value.issues.length)||value.complete!==(value.totalIssues===0))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Inventory issue totals and completeness disagree.'});
});
export const workspaceBackupEntrySchema=z.object({
 path:payloadPath,role:z.enum(['database','asset','image_stage','frame_stage','receipt_media','uncommitted_video','uncommitted_export']),
 bytes:integer.max(WORKSPACE_BACKUP_LIMITS.fileBytes),sha256:hash,
}).strict().superRefine((value,ctx)=>{
 const valid=value.role==='database'?value.path==='payload/workbench.sqlite'&&value.bytes>0&&value.bytes<=WORKSPACE_BACKUP_LIMITS.databaseBytes:
 value.role==='image_stage'?value.path.startsWith('payload/image-staging/'):
 value.role==='frame_stage'?value.path.startsWith('payload/frame-staging/'):
 value.role==='uncommitted_video'?value.path.startsWith('payload/media/result-'):
 value.role==='uncommitted_export'?value.path.startsWith('payload/media/export-'):
 value.role==='receipt_media'?new RegExp(`^payload/media/${uuid}\\.png$`,'i').test(value.path):media.test(value.path);
 if(!valid)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Payload role does not match its path or size.'});
});
export const workspaceBackupManifestSchema=z.object({
 format:z.literal(WORKSPACE_BACKUP_FORMAT),formatVersion:z.literal(1),backupId:z.string().uuid(),
 createdAt:z.string().datetime(),applicationVersion:z.string().min(1).max(64).regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/),
 databaseSchemaVersion:z.number().int().min(1).max(24),scope:z.literal('whole_workspace'),
 entries:z.array(workspaceBackupEntrySchema).min(1).max(WORKSPACE_BACKUP_LIMITS.fileCount),inventory:workspaceBackupInventorySchema,
}).strict().superRefine((value,ctx)=>{
 let bytes=0;const paths=new Set();let databases=0,previous='';
 for(const entry of value.entries){bytes+=entry.bytes;if(paths.has(entry.path)||entry.path<=previous)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Entries must have unique, lexically sorted paths.'});paths.add(entry.path);previous=entry.path;if(entry.role==='database')databases++;}
 if(databases!==1||bytes>WORKSPACE_BACKUP_LIMITS.totalBytes)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Exactly one database and a bounded total payload are required.'});
});
export const workspaceBackupCompleteSchema=z.object({
 format:z.literal(WORKSPACE_BACKUP_FORMAT),formatVersion:z.literal(1),backupId:z.string().uuid(),manifestSha256:hash,
 fileCount:integer.min(1).max(WORKSPACE_BACKUP_LIMITS.fileCount),payloadBytes:integer.min(1).max(WORKSPACE_BACKUP_LIMITS.totalBytes),
}).strict();
export const workspaceBackupResultSchema=z.object({
 format:z.literal(WORKSPACE_BACKUP_FORMAT),formatVersion:z.literal(1),backupId:z.string().uuid(),
 integrity:z.literal('verified'),restoration:z.literal('not_tested'),warnings:z.array(z.literal('SOURCE_LOCK_RELEASE_UNCONFIRMED')).length(1).optional(),databaseSchemaVersion:z.number().int().min(1).max(24),
 fileCount:integer.min(1).max(WORKSPACE_BACKUP_LIMITS.fileCount),payloadBytes:integer.min(1).max(WORKSPACE_BACKUP_LIMITS.totalBytes),inventory:workspaceBackupInventorySchema,
}).strict();

export const workspaceBackupSchemas={'workspace.backup.inspect':z.object({}).strict().describe('Reads bounded workspace database counts for an offline backup. No path input, file copying, task recovery, credentials or provider calls. The running backend must be closed before cold capture.')};
const count=integer.nullable();
export const workspaceBackupInspectionSchema=z.object({
 formatVersion:z.literal(1),scope:z.literal('whole_workspace'),captureReady:z.literal(false),reason:z.literal('BACKEND_RUNNING'),
 databaseSchemaVersion:z.number().int().min(1).max(24).nullable(),
 counts:z.object({projects:count,assets:count,videoTasks:count,imageTasks:count,frameTasks:count,exports:count}).strict(),
 unresolved:z.object({videoTasks:count,imageTasks:count,frameTasks:count,exports:count,agentRuns:count,agentProposals:count,editTasks:count}).strict(),
 limits:z.object(Object.fromEntries(Object.entries(WORKSPACE_BACKUP_LIMITS).map(([key,value])=>[key,z.literal(value)]))).strict(),
 inspectionComplete:z.boolean(),issues:z.array(z.enum(['ROW_LIMIT','JSON_LIMIT','INVALID_ROW','SCHEMA_UNSUPPORTED','DATABASE_UNAVAILABLE'])).max(5),
}).strict().superRefine((value,ctx)=>{
 const complete=value.databaseSchemaVersion!==null&&[...Object.values(value.counts),...Object.values(value.unresolved)].every(v=>v!==null)&&value.issues.length===0;
 if(value.inspectionComplete!==complete||new Set(value.issues).size!==value.issues.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Inspection completeness must reflect bounded known counts.'});
});
export function isWorkspaceBackupInspection(value){return workspaceBackupInspectionSchema.safeParse(value).success;}
