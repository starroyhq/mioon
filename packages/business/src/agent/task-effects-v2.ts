import {AsyncLocalStorage} from 'node:async_hooks';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '@mioon/contracts';
import type {AgentTaskChange,AgentTaskJson} from '../../../contracts/src/agent-tasks-v2.ts';

export type TaskChangeInput=Omit<AgentTaskChange,'id'|'runId'|'stepId'|'createdAt'|'status'>;
export interface AgentTaskEffectOrigin {
 readonly runId:string;readonly stepId:string;readonly projectId:string;readonly requestId:string;
 readonly operation:string;readonly beforeEffect:()=>void;
 readonly recordInside:(result:AgentTaskJson,changes?:TaskChangeInput[])=>void;
 readonly appendChangesInside?:(changes:TaskChangeInput[])=>void;
 importHandle?:string;
 effectFailure?:unknown;
 recorded:boolean;
}
const origins=new AsyncLocalStorage<AgentTaskEffectOrigin>();
export function taskEffectOrigin():AgentTaskEffectOrigin|undefined{return origins.getStore();}
/** Retain the trusted denial even if a legacy media reader sanitizes errors. */
export function assertTaskEffectOrigin():void{
 const origin=taskEffectOrigin();if(!origin)return;if(origin.effectFailure)throw origin.effectFailure;
 try{origin.beforeEffect();}catch(error){origin.effectFailure=error;throw error;}
}
export function withTaskEffectOrigin<T>(origin:AgentTaskEffectOrigin,callback:()=>T):T{return origins.run(origin,callback);}
export interface AgentTaskJobBinding {runId:string;stepId:string;projectId:string;requestId:string;operation:string}
export type AgentTaskJobGate=(binding:AgentTaskJobBinding)=>void;
const gates=new WeakMap<DatabaseSync,AgentTaskJobGate>();
const blockedEffects=new WeakSet<object>();
const jobResumers=new WeakMap<DatabaseSync,Map<string,(runId:string)=>void>>();
const jobStoppers=new WeakMap<DatabaseSync,Map<string,(runId:string,stepId?:string)=>void>>();
export function isAgentTaskEffectBlocked(error:unknown):boolean{return error!==null&&typeof error==='object'&&blockedEffects.has(error);}
export function setAgentTaskJobResumer(db:DatabaseSync,kind:string,resume:(runId:string)=>void):()=>void{
 let entries=jobResumers.get(db);if(!entries){entries=new Map();jobResumers.set(db,entries);}entries.set(kind,resume);
 return ()=>{if(entries.get(kind)===resume)entries.delete(kind);};
}
/** Requeue only previously accepted local tasks. No new business request. */
export function resumeAgentTaskJobs(db:DatabaseSync,runId:string):void{for(const resume of jobResumers.get(db)?.values()??[])resume(runId);}
export function setAgentTaskJobStopper(db:DatabaseSync,kind:string,stop:(runId:string,stepId?:string)=>void):()=>void{
 let entries=jobStoppers.get(db);if(!entries){entries=new Map();jobStoppers.set(db,entries);}entries.set(kind,stop);
 return ()=>{if(entries.get(kind)===stop)entries.delete(kind);};
}
function backgroundDenied(db:DatabaseSync,runId:string,stepId:string):boolean{
 return db.prepare("SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.data.backgroundDenied') END AS denied FROM agent_task_steps_v2 WHERE id=? AND runId=?").get(stepId,runId)?.denied===1;
}
/** Retire only provably unstarted work, scoped to a stopped run or one denied
 * accepted step. A single rejection never expands to the run's other jobs. */
export function stopAgentTaskJobs(db:DatabaseSync,runId:string,stepId?:string):void{
 if(stepId){if(!backgroundDenied(db,runId,stepId))throw new AppError('AGENT_TASK_EFFECT_BLOCKED','此步骤没有已保存的后台拒绝回执',409);}
 else if(!['stopped','reverted','failed'].includes(String(db.prepare('SELECT status FROM agent_task_runs_v2 WHERE id=?').get(runId)?.status)))return;
 for(const stop of jobStoppers.get(db)?.values()??[])stop(runId,stepId);
}
export function isAgentTaskJobStopped(db:DatabaseSync,kind:string,id:string):boolean{
 const binding=agentTaskJobBinding(db,kind,id);return !!binding&&(['stopped','reverted','failed'].includes(String(db.prepare('SELECT status FROM agent_task_runs_v2 WHERE id=? AND projectId=?').get(binding.runId,binding.projectId)?.status))||backgroundDenied(db,binding.runId,binding.stepId));
}
const dispatchRecorders=new WeakMap<DatabaseSync,(binding:AgentTaskJobBinding)=>void>();
const targetGates=new WeakMap<DatabaseSync,(binding:AgentTaskJobBinding,target:{kind:string;id:string})=>boolean>();
export function setAgentTaskJobTargetGate(db:DatabaseSync,gate:(binding:AgentTaskJobBinding,target:{kind:string;id:string})=>boolean):()=>void{targetGates.set(db,gate);return ()=>{if(targetGates.get(db)===gate)targetGates.delete(db);};}
export function allowAgentTaskJobTargetMutation(db:DatabaseSync,kind:string,id:string,target:{kind:string;id:string}):boolean{
 const binding=agentTaskJobBinding(db,kind,id);if(!binding)return true;
 return targetGates.get(db)?.(binding,target)??false;
}
export function setAgentTaskJobDispatchRecorder(db:DatabaseSync,recorder:(binding:AgentTaskJobBinding)=>void):()=>void{dispatchRecorders.set(db,recorder);return ()=>{if(dispatchRecorders.get(db)===recorder)dispatchRecorders.delete(db);};}
export function recordAgentTaskJobDispatch(db:DatabaseSync,kind:string,id:string):void{
 const binding=agentTaskJobBinding(db,kind,id);if(!binding)return;
 const record=dispatchRecorders.get(db);if(!record)throw new AppError('AGENT_TASK_EFFECT_BLOCKED','任务费用记录尚未恢复',409);record(binding);
}
type JobOriginRunner=<T>(binding:AgentTaskJobBinding,callback:()=>T)=>T;
const jobOrigins=new WeakMap<DatabaseSync,JobOriginRunner>();
export function setAgentTaskJobOriginRunner(db:DatabaseSync,runner:JobOriginRunner):()=>void{jobOrigins.set(db,runner);return ()=>{if(jobOrigins.get(db)===runner)jobOrigins.delete(db);};}
export function withAgentTaskJobOrigin<T>(db:DatabaseSync,kind:string,id:string,callback:()=>T):T{
 const binding=agentTaskJobBinding(db,kind,id),runner=jobOrigins.get(db);if(!binding)return callback();
 if(!runner)throw new AppError('AGENT_TASK_EFFECT_BLOCKED','任务执行日志尚未恢复',409);
 return runner(binding,callback);
}
/** Only the backend runtime registers this gate. A persisted binding alone is
 * never permission to submit after restart, pause, revocation or a policy edit. */
export function setAgentTaskEffectGate(db:DatabaseSync,gate:AgentTaskJobGate):()=>void{
 gates.set(db,gate);return ()=>{if(gates.get(db)===gate)gates.delete(db);};
}
export function bindAgentTaskJobInside(db:DatabaseSync,kind:string,id:string):void{
 const origin=taskEffectOrigin();if(!origin)return;
 if(!db.isTransaction)throw Error('Agent task admission must share the domain transaction');
 db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)')
  .run(kind,id,origin.runId,origin.stepId,origin.projectId,origin.requestId,origin.operation);
}
export function agentTaskJobBinding(db:DatabaseSync,kind:string,id:string):AgentTaskJobBinding|undefined{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_job_origins_v2'").get())return;
 const row=db.prepare('SELECT runId,stepId,projectId,requestId,operation FROM agent_task_job_origins_v2 WHERE kind=? AND jobId=?').get(kind,id);
 if(!row)return;
 if(Object.values(row).some(value=>typeof value!=='string'))throw new AppError('AGENT_TASK_STORAGE_UNAVAILABLE','任务来源记录无法验证',503);
 return {runId:String(row.runId),stepId:String(row.stepId),projectId:String(row.projectId),requestId:String(row.requestId),operation:String(row.operation)};
}
export function assertAgentTaskJobEffect(db:DatabaseSync,kind:string,id:string):void{
 const binding=agentTaskJobBinding(db,kind,id);if(!binding)return;
 assertAgentTaskBindingEffect(db,binding);
}
export function assertAgentTaskBindingEffect(db:DatabaseSync,binding:AgentTaskJobBinding):void{
 try{const gate=gates.get(db);if(!gate)throw new AppError('AGENT_TASK_EFFECT_BLOCKED','任务执行权限尚未恢复',409);gate(binding);}
 catch(error){if(error!==null&&typeof error==='object')blockedEffects.add(error);throw error;}
}
