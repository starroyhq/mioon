import type {DatabaseSync} from 'node:sqlite';
import {AGENT_TASK_STORAGE_TABLES,agentTaskStorageSnapshotSchema} from '@mioon/contracts/agent-task-storage';
import type {AgentTaskStorageSnapshot} from '@mioon/contracts/agent-task-storage';
import {readCurrentWorkspaceRole,isWorkspaceRoleSince,isPrivateStorageWorkspaceRole} from '../workspace-schema-dispatch.ts';

/** Read only aggregate counts from fixed local table names. No request, prompt,
 * credential, path or provider data crosses this management diagnostic. */
export function readAgentTaskStorage(db:DatabaseSync):AgentTaskStorageSnapshot {
 // Model request references exist from schema60 on and in private storage.
 const role=readCurrentWorkspaceRole(db),references=isWorkspaceRoleSince(role,60)||isPrivateStorageWorkspaceRole(role);
 const limits={bytes:references?268435456:67108864,rows:20000,rowBytes:2097152,eventPageBytes:8388608} as const;
 const available=!!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='agent_task_runs_v2'").get();
 const tables=available?AGENT_TASK_STORAGE_TABLES.map(name=>{
  const countedRows=name!=='agent_task_edit_receipts_v2',countedBytes=!['agent_task_job_origins_v2','agent_task_imports_v2'].includes(name);
  const value=db.prepare(`SELECT count(*) AS rows,${countedBytes?'coalesce(sum(length(CAST(data AS BLOB))),0)':'0'} AS bytes FROM ${name}`).get();
  return {name,rows:Number(value?.rows),bytes:Number(value?.bytes),countedRows,countedBytes};
 }):[];
 const usage={bytes:tables.reduce((sum,table)=>sum+(table.countedBytes?table.bytes:0),0),rows:tables.reduce((sum,table)=>sum+(table.countedRows?table.rows:0),0)};
 const remaining={bytes:Math.max(0,limits.bytes-usage.bytes),rows:Math.max(0,limits.rows-usage.rows)};
 const status=!available?'unavailable':usage.bytes>=limits.bytes||usage.rows>=limits.rows?'full':usage.bytes>=limits.bytes*.9||usage.rows>=limits.rows*.9?'near_limit':'available';
 return agentTaskStorageSnapshotSchema.parse({version:1,format:!available?'unavailable':references?'model_request_references':'inline',status,limits,usage,remaining,tables});
}
