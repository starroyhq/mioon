import type {DatabaseSync} from 'node:sqlite';
import {readWorkspaceBackupSchemaVersion} from './workspace-backup-schema-versions.ts';
import {WORKSPACE_BACKUP_LIMITS,workspaceBackupInspectionSchema,IMAGE_STATES,FRAME_STATES} from '@mioon/contracts';

// A live-backend DB summary only. Never follows file paths, opens a file, starts
// work, reconciles a task or grants cold-snapshot/restore authority.
export const BACKUP_INSPECTION_LIMITS=Object.freeze({rowsPerTable:20_000,jsonBytesPerTable:16*1024*1024,jsonRowBytes:128*1024});
interface TaskDefinition {
 readonly table: string;
 readonly json?: boolean;
 readonly column?: string;
 readonly states: readonly string[];
 readonly terminal: readonly string[];
}
const definitions: Readonly<Record<string,TaskDefinition>>={
 videoTasks:{table:'jobs',json:true,states:['queued','submitting','running','downloading','submission_unknown','succeeded','failed','cancelled'],terminal:['succeeded','failed','cancelled']},
 imageTasks:{table:'image_tasks',column:'state',states:IMAGE_STATES,terminal:['succeeded','failed','cancelled_before_dispatch']},
 frameTasks:{table:'frame_tasks',column:'state',states:FRAME_STATES,terminal:['succeeded','failed','cancelled_before_start']},
 exports:{table:'exports',json:true,states:['queued','running','succeeded','failed','cancelled'],terminal:['succeeded','failed','cancelled']},
 agentRuns:{table:'agent_chat_runs',column:'status',states:['running','completed','failed','stopped','interrupted'],terminal:['completed','failed','stopped']},
 agentProposals:{table:'agent_edit_proposals',column:'status',states:['pending','approved','dispatching','unknown','applied','failed','rejected','cancelled'],terminal:['applied','failed','rejected','cancelled']},
 editTasks:{table:'edit_tasks',column:'status',states:['prepared','dispatching','unknown','applied','not_applied'],terminal:['applied','not_applied']},
};
const totalTables: Readonly<Record<string,string>>={projects:'projects',assets:'assets',videoTasks:'jobs',imageTasks:'image_tasks',frameTasks:'frame_tasks',exports:'exports'};
const finite=(value: unknown): number=>typeof value==='number'?value:0;
export function inspectWorkspaceBackup(store: {readonly db: DatabaseSync}) {
 const db=store.db,issues=new Set<string>(),counts: Record<string, number|null>={},unresolved: Record<string, number|null>={},boundedCounts=new Map<string, number|null>();let databaseSchemaVersion: number|null=null;
 const add=(code: string): void=>{issues.add(code);},cap=BACKUP_INSPECTION_LIMITS.rowsPerTable;
 const count=(table: string): number|null=>{
  if(boundedCounts.has(table))return boundedCounts.get(table)??null;
  const value=finite(db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ${cap+1})`).get()?.n);
  const result=value>cap?(add('ROW_LIMIT'),null):value;boundedCounts.set(table,result);return result;
 };
 const started=!db.isTransaction;
 try{
  if(started)db.exec('BEGIN');
  try{databaseSchemaVersion=readWorkspaceBackupSchemaVersion(db);}catch{add('SCHEMA_UNSUPPORTED');}
  for(const [key,table] of Object.entries(totalTables))counts[key]=count(table);
  for(const [key,d] of Object.entries(definitions)){
   if(count(d.table)===null){unresolved[key]=null;continue;}
   let expression: string;
   if(d.json){
    const sizes=db.prepare(`SELECT COALESCE(SUM(bytes),0) AS bytes,COALESCE(MAX(bytes),0) AS maximum FROM (SELECT length(CAST(data AS BLOB)) AS bytes FROM ${d.table} LIMIT ${cap})`).get();
    const bytes=finite(sizes?.bytes),maximum=finite(sizes?.maximum);
    if(bytes>BACKUP_INSPECTION_LIMITS.jsonBytesPerTable||maximum>BACKUP_INSPECTION_LIMITS.jsonRowBytes){add('JSON_LIMIT');unresolved[key]=null;continue;}
    expression="CASE WHEN typeof(data)='text' AND json_valid(data) THEN CASE WHEN json_type(data,'$.status')='text' AND length(json_extract(data,'$.status'))<=40 THEN json_extract(data,'$.status') END END";
   }else expression=`CASE WHEN typeof(${d.column})='text' AND length(${d.column})<=40 THEN ${d.column} END`;
   const rows=db.prepare(`SELECT ${expression} AS state FROM ${d.table} LIMIT ${cap}`).all();
   if(rows.some(row=>typeof row.state!=='string'||!d.states.includes(row.state))){add('INVALID_ROW');unresolved[key]=null;continue;}
   unresolved[key]=rows.reduce((total,row)=>total+(typeof row.state==='string'&&d.terminal.includes(row.state)?0:1),0);
  }
  if([52,54].includes(databaseSchemaVersion??0)&&unresolved.agentRuns!==null){
   if(count('agent_task_runs_v2')===null)unresolved.agentRuns=null;
   else unresolved.agentRuns=(unresolved.agentRuns??0)+finite(db.prepare("SELECT count(*) AS n FROM agent_task_runs_v2 r WHERE r.status NOT IN ('completed','failed','stopped','reverted') OR EXISTS(SELECT 1 FROM agent_task_steps_v2 s WHERE s.runId=r.id AND s.status IN ('dispatch_started','unknown'))").get()?.n);
  }
  if(started)db.exec('COMMIT');
 }catch{
  if(started&&db.isTransaction)db.exec('ROLLBACK');
  add('DATABASE_UNAVAILABLE');databaseSchemaVersion=null;
  for(const key of Object.keys(totalTables))counts[key]=null;
  for(const key of Object.keys(definitions))unresolved[key]=null;
 }
 return workspaceBackupInspectionSchema.parse({formatVersion:1,scope:'whole_workspace',captureReady:false,reason:'BACKEND_RUNNING',databaseSchemaVersion,counts,unresolved,
  limits:{...WORKSPACE_BACKUP_LIMITS},inspectionComplete:issues.size===0,issues:[...issues]});
}
