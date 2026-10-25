import {z} from 'zod';

export const AGENT_TASK_STORAGE_TABLES=Object.freeze(['agent_task_runs_v2','agent_task_steps_v2','agent_task_changes_v2','agent_task_events_v2','agent_task_controls_v2','agent_task_control_states_v2','agent_task_policy_v2','agent_task_policy_requests_v2','agent_task_edit_receipts_v2','agent_task_job_origins_v2','agent_task_imports_v2'] as const);
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const agentTaskStorageSnapshotSchema=z.object({
 version:z.literal(1),format:z.enum(['inline','model_request_references','unavailable']),status:z.enum(['available','near_limit','full','unavailable']),
 limits:z.object({bytes:z.union([z.literal(67108864),z.literal(268435456)]),rows:z.literal(20000),rowBytes:z.literal(2097152),eventPageBytes:z.literal(8388608)}).strict(),
 usage:z.object({bytes:count,rows:count}).strict(),remaining:z.object({bytes:count,rows:count}).strict(),
 tables:z.array(z.object({name:z.enum(AGENT_TASK_STORAGE_TABLES),bytes:count,rows:count,countedBytes:z.boolean(),countedRows:z.boolean()}).strict()).max(AGENT_TASK_STORAGE_TABLES.length),
}).strict().refine(value=>{
 if(new Set(value.tables.map(table=>table.name)).size!==value.tables.length)return false;
 const bytes=value.tables.reduce((sum,table)=>sum+(table.countedBytes?table.bytes:0),0),rows=value.tables.reduce((sum,table)=>sum+(table.countedRows?table.rows:0),0);
 if(value.usage.bytes!==bytes||value.usage.rows!==rows||value.remaining.bytes!==Math.max(0,value.limits.bytes-bytes)||value.remaining.rows!==Math.max(0,value.limits.rows-rows))return false;
 if(value.format==='unavailable')return value.status==='unavailable'&&value.tables.length===0;
 if(value.tables.length!==AGENT_TASK_STORAGE_TABLES.length||value.limits.bytes!==(value.format==='model_request_references'?268435456:67108864))return false;
 const status=bytes>=value.limits.bytes||rows>=value.limits.rows?'full':bytes>=value.limits.bytes*.9||rows>=value.limits.rows*.9?'near_limit':'available';
 return value.status===status&&value.tables.every(table=>table.countedRows===(table.name!=='agent_task_edit_receipts_v2')&&table.countedBytes===!['agent_task_job_origins_v2','agent_task_imports_v2'].includes(table.name));
},{message:'Storage counters must match their bounded table inventory.'});
export type AgentTaskStorageSnapshot=z.infer<typeof agentTaskStorageSnapshotSchema>;
