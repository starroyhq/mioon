import {validateWorkspaceSchema62} from './workspace-schema-v62.ts';
import {validateWorkspaceSchema60} from './workspace-schema-v60.ts';
import {validateWorkspaceSchema58} from './workspace-schema-v58.ts';
import {validateWorkspaceSchema56} from './workspace-schema-v56.ts';
import {validateWorkspaceSchema54} from './workspace-schema-v54.ts';
import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {validateWorkspaceSchema50} from './workspace-schema-v50.ts';
import {validateWorkspaceSchema52} from './workspace-schema-v52.ts';
import {readCurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import {AppError} from '../../contracts/src/app-error.ts';
import {taskDispositionSchemas, taskDispositionSchema, isTaskDispositionUnicode, isTaskDispositionMutationResponse} from '../../contracts/src/task-dispositions.ts';
import type {TaskDisposition, TaskDispositionKind, TaskDispositionTarget, TaskDispositionCheckedTarget, TaskDispositionListInput, TaskDispositionMarkFailedInput, TaskDispositionArchiveInput, TaskDispositionMutationResponse} from '../../contracts/src/task-dispositions.ts';

interface Store {db:DatabaseSync; tx<T>(callback:()=>T):T}
interface Options {ownsLock():boolean; isReadOnly():boolean; signal?:AbortSignal; now?:()=>string; fault?:(point:'beforeCommit'|'afterCommit')=>void}
interface Source {status:string; requestId:string|null; canMarkFailed:boolean; canArchive:boolean}
interface Saved {revision:number; markedFailedAt:string|null; archivedAt:string|null; sourceStatus:string; sourceRequestId:string|null; createdAt:string; updatedAt:string}
type MutationInput = TaskDispositionMarkFailedInput|TaskDispositionArchiveInput;
type MutationOperation = TaskDispositionMutationResponse['operation'];
type Row = Record<string, SQLInputValue>;
const object = (value:unknown):value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value:unknown):string => JSON.stringify(value, (_key,item:unknown) => object(item) ? Object.fromEntries(Object.entries(item).sort(([left],[right])=>left.localeCompare(right))) : item);
const digest = (value:unknown):string => createHash('sha256').update(canonical(value)).digest('hex');
function fail(code:string, status=409):never {
  const labels:Record<string,string> = {
    TASK_DISPOSITION_VALIDATION:'任务处置参数无效', TASK_DISPOSITION_NOT_FOUND:'找不到此项目的任务',
    TASK_DISPOSITION_UNAVAILABLE:'无法安全读取或保存任务处置', TASK_DISPOSITION_CONFLICT:'任务状态或本地处置已改变，请重新读取',
    TASK_DISPOSITION_STATE:'此任务仍在运行、待对账或尚未明确终结，不能执行此处置',
    TASK_DISPOSITION_CONFIRMATION:'标记失败需要明确确认', IDEMPOTENCY_CONFLICT:'同一请求 ID 已用于不同操作或内容',
  };
  throw new AppError(code,labels[code] ?? labels.TASK_DISPOSITION_UNAVAILABLE,status);
}
function plain(value:unknown, depth=0, budget={count:0}):void {
  if (++budget.count>2500 || depth>5 || isProxy(value)) fail('TASK_DISPOSITION_VALIDATION',400);
  if (value===null || typeof value==='boolean') return;
  if (typeof value==='string') {if(!isTaskDispositionUnicode(value))fail('TASK_DISPOSITION_VALIDATION',400);return;}
  if (typeof value==='number') {if(!Number.isFinite(value))fail('TASK_DISPOSITION_VALIDATION',400);return;}
  if (!value || typeof value!=='object' || ![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(value))) fail('TASK_DISPOSITION_VALIDATION',400);
  for (const key of Reflect.ownKeys(value)) {
    if(Array.isArray(value)&&key==='length')continue;
    const entry=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||!entry?.enumerable||!Object.hasOwn(entry,'value'))fail('TASK_DISPOSITION_VALIDATION',400);
    plain(entry.value,depth+1,budget);
  }
}
function parse<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}},value:unknown):T {
  plain(value); const parsed=schema.safeParse(value); if(!parsed.success)fail('TASK_DISPOSITION_VALIDATION',400);return parsed.data;
}

/** Presentation-only disposition ledger. No underlying job/task transition,
 * provider call, retry, file deletion or receipt cleanup is performed here. */
export function createTaskDispositionServices(store:Store,{ownsLock,isReadOnly,signal,now=()=>new Date().toISOString(),fault=()=>{}}:Options) {
  const {db}=store;
  function available(write=false):void {
    if(signal?.aborted || write && (isReadOnly() || !ownsLock()))fail('TASK_DISPOSITION_UNAVAILABLE');
    const tables=db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name IN ('task_dispositions','task_disposition_requests')").all();
    if(tables.length!==2)fail('TASK_DISPOSITION_UNAVAILABLE');
    if(write){try{if(readCurrentWorkspaceRole(db)==='ordinary-62')validateWorkspaceSchema62(db);else if(readCurrentWorkspaceRole(db)==='ordinary-60')validateWorkspaceSchema60(db);else if(readCurrentWorkspaceRole(db)==='ordinary-58')validateWorkspaceSchema58(db);else if(readCurrentWorkspaceRole(db)==='ordinary-56')validateWorkspaceSchema56(db);else if(readCurrentWorkspaceRole(db)==='ordinary-54')validateWorkspaceSchema54(db);else if(readCurrentWorkspaceRole(db)==='ordinary-52')validateWorkspaceSchema52(db);else validateWorkspaceSchema50(db);}catch{fail('TASK_DISPOSITION_UNAVAILABLE');}}
  }
  function project(projectId:string):void {
    const row=db.prepare(`SELECT id,CASE WHEN length(CAST(data AS BLOB))<=1048576 AND json_valid(data) THEN json_extract(data,'$.id') END AS bodyId FROM projects WHERE id=?`).get(projectId);
    if(!row||row.id!==projectId||row.bodyId!==projectId)fail('TASK_DISPOSITION_NOT_FOUND',404);
  }
  function source(projectId:string,target:TaskDispositionTarget):Source {
    if(target.kind==='edit') {
      const row=db.prepare('SELECT id,projectId,status,requestId,acknowledged FROM edit_tasks WHERE id=? AND projectId=?').get(target.taskId,projectId);
      if(!row||row.id!==target.taskId||row.projectId!==projectId)fail('TASK_DISPOSITION_NOT_FOUND',404);
      if(typeof row.status!=='string'||typeof row.requestId!=='string'||!isTaskDispositionUnicode(row.requestId)||row.requestId.length<8||row.requestId.length>200)fail('TASK_DISPOSITION_UNAVAILABLE');
      return {status:row.status,requestId:row.requestId,canMarkFailed:row.status==='unknown',canArchive:['applied','not_applied'].includes(row.status)&&row.acknowledged===1};
    }
    const table=target.kind==='generation'?'jobs':'exports';
    const fields=['id','projectId','status','requestId','phase','providerJobId','submissionCount'] as const;
    const columns=fields.map(field=>`CASE WHEN length(CAST(data AS BLOB))<=4194304 AND json_valid(data) THEN json_extract(data,'$.${field}') END AS body_${field}`).join(',');
    const row=db.prepare(`SELECT id,projectId,${columns} FROM ${table} WHERE id=? AND projectId=?`).get(target.taskId,projectId);
    if(!row||row.id!==target.taskId||row.projectId!==projectId||row.body_id!==row.id||row.body_projectId!==projectId)fail('TASK_DISPOSITION_NOT_FOUND',404);
    if(typeof row.body_status!=='string'||row.body_status.length<1||row.body_status.length>40||row.body_requestId!==null&&(typeof row.body_requestId!=='string'||row.body_requestId.length<8||row.body_requestId.length>200||!isTaskDispositionUnicode(row.body_requestId)))fail('TASK_DISPOSITION_UNAVAILABLE');
    const status=row.body_status,requestId=typeof row.body_requestId==='string'?row.body_requestId:null;
    // Local cancellation of an already submitted generation is still an open
    // provider outcome. It must never disappear through "clear completed".
    const unresolved=target.kind==='generation'&&(row.body_phase==='output_review_required'||status==='cancelled'&&(row.body_providerJobId!==null||typeof row.body_submissionCount==='number'&&row.body_submissionCount>0));
    return {status,requestId,canMarkFailed:target.kind==='generation'&&status==='submission_unknown',canArchive:['succeeded','failed','cancelled'].includes(status)&&!unresolved};
  }
  function saved(projectId:string,target:TaskDispositionTarget):Saved|null {
    const row=db.prepare('SELECT revision,markedFailedAt,archivedAt,sourceStatus,sourceRequestId,createdAt,updatedAt FROM task_dispositions WHERE projectId=? AND kind=? AND taskId=?').get(projectId,target.kind,target.taskId);
    if(!row)return null;
    if(!Number.isSafeInteger(row.revision)||Number(row.revision)<1||typeof row.sourceStatus!=='string'||typeof row.createdAt!=='string'||typeof row.updatedAt!=='string'||row.markedFailedAt!==null&&typeof row.markedFailedAt!=='string'||row.archivedAt!==null&&typeof row.archivedAt!=='string'||row.sourceRequestId!==null&&typeof row.sourceRequestId!=='string')fail('TASK_DISPOSITION_UNAVAILABLE');
    return row as unknown as Saved;
  }
  function current(projectId:string,target:TaskDispositionTarget,observed=source(projectId,target)):TaskDisposition {
    const row=saved(projectId,target);
    if(row&&row.sourceRequestId!==observed.requestId)fail('TASK_DISPOSITION_UNAVAILABLE');
    const result={projectId,kind:target.kind,taskId:target.taskId,revision:row?.revision??0,markedFailed:Boolean(row?.markedFailedAt),archived:Boolean(row?.archivedAt),updatedAt:row?.updatedAt??null,sourceStatus:observed.status,sourceRequestId:observed.requestId,canMarkFailed:observed.canMarkFailed,canArchive:observed.canArchive};
    if(!taskDispositionSchema.safeParse(result).success)fail('TASK_DISPOSITION_UNAVAILABLE');
    return result;
  }
  function list(input:unknown) {
    const parsed=parse(taskDispositionSchemas['task.disposition.list'],input);available();
    // One read snapshot, no transaction upgrade, DDL or implicit task activity.
    if(db.isTransaction)fail('TASK_DISPOSITION_UNAVAILABLE');db.exec('BEGIN');
    try {project(parsed.projectId);const result={projectId:parsed.projectId,items:parsed.targets.map(target=>current(parsed.projectId,target))};db.exec('COMMIT');return result;}
    catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  function mutate(operation:MutationOperation,input:MutationInput,targets:readonly TaskDispositionCheckedTarget[]):TaskDispositionMutationResponse {
    available(true);const requestHash=digest({operation,input});
    const result=store.tx(()=>{
      available(true);project(input.projectId);
      const sources=targets.map(target=>source(input.projectId,target));
      const prior=db.prepare('SELECT operation,projectId,digest,CASE WHEN length(CAST(response AS BLOB))<=131072 THEN response END AS response FROM task_disposition_requests WHERE requestId=?').get(input.requestId);
      if(prior) {
        if(prior.operation!==operation||prior.projectId!==input.projectId||prior.digest!==requestHash)fail('IDEMPOTENCY_CONFLICT');
        let value:unknown;try{value=JSON.parse(String(prior.response));}catch{fail('TASK_DISPOSITION_UNAVAILABLE');}
        if(!isTaskDispositionMutationResponse(value)||value.operation!==operation||value.projectId!==input.projectId||value.requestId!==input.requestId||value.items.length!==targets.length||value.items.some((item,index)=>item.kind!==targets[index].kind||item.taskId!==targets[index].taskId||current(input.projectId,targets[index],sources[index]).revision<item.revision))fail('TASK_DISPOSITION_UNAVAILABLE');
        return value;
      }
      const before=targets.map((target,index)=>current(input.projectId,target,sources[index]));
      for(let index=0;index<targets.length;index++) {
        if(before[index].revision!==targets[index].expectedRevision||sources[index].status!==targets[index].expectedStatus)fail('TASK_DISPOSITION_CONFLICT');
        if(operation==='task.disposition.markFailed'?!sources[index].canMarkFailed:!sources[index].canArchive)fail('TASK_DISPOSITION_STATE');
        if(before[index].revision>=Number.MAX_SAFE_INTEGER)fail('TASK_DISPOSITION_CONFLICT');
      }
      const timestamp=now();if(!Number.isFinite(Date.parse(timestamp)))fail('TASK_DISPOSITION_UNAVAILABLE');
      for(let index=0;index<targets.length;index++) {
        const target=targets[index],old=saved(input.projectId,target),marked=old?.markedFailedAt??(operation==='task.disposition.markFailed'?timestamp:null),archived=old?.archivedAt??(operation==='task.disposition.archiveCompleted'?timestamp:null);
        if(old)db.prepare('UPDATE task_dispositions SET revision=?,markedFailedAt=?,archivedAt=?,sourceStatus=?,updatedAt=? WHERE projectId=? AND kind=? AND taskId=?')
          .run(before[index].revision+1,marked,archived,sources[index].status,timestamp,input.projectId,target.kind,target.taskId);
        else db.prepare('INSERT INTO task_dispositions(projectId,kind,taskId,revision,markedFailedAt,archivedAt,sourceStatus,sourceRequestId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(input.projectId,target.kind,target.taskId,before[index].revision+1,marked,archived,sources[index].status,sources[index].requestId,timestamp,timestamp);
      }
      const response:TaskDispositionMutationResponse={operation,requestId:input.requestId,projectId:input.projectId,items:targets.map((target,index)=>current(input.projectId,target,sources[index]))};
      if(!isTaskDispositionMutationResponse(response))fail('TASK_DISPOSITION_UNAVAILABLE');
      const serialized=JSON.stringify(response);if(Buffer.byteLength(serialized)>131072)fail('TASK_DISPOSITION_UNAVAILABLE');
      db.prepare('INSERT INTO task_disposition_requests(requestId,projectId,operation,digest,response) VALUES(?,?,?,?,?)').run(input.requestId,input.projectId,operation,requestHash,serialized);
      fault('beforeCommit');return response;
    });
    fault('afterCommit');return result;
  }
  return {handlers:{
    'task.disposition.list':list,
    'task.disposition.markFailed':(input:unknown)=>{const parsed=parse(taskDispositionSchemas['task.disposition.markFailed'],input);return mutate('task.disposition.markFailed',parsed,[parsed]);},
    'task.disposition.archiveCompleted':(input:unknown)=>{const parsed=parse(taskDispositionSchemas['task.disposition.archiveCompleted'],input);return mutate('task.disposition.archiveCompleted',parsed,parsed.targets);},
  }};
}
