import {readCurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import {assertTimelineVolumeEnvelopeWorkspace} from './timeline-volume-envelope-admission.ts';
import {assertTimelineAudioRoleWorkspace} from './workspace-schema-dispatch.ts';
import {getWorkspaceRestoreContext as legacyRestoreContext} from './workspace-restore-schema.ts';
import {refuseRestoredTask as legacyRefuseTask,safeWorkspaceRestoreError,assertWorkspaceRestoreOrigin as legacyAssertOrigin,assertRestoreRequestVacant as legacyRequestVacant} from './workspace-restore-policy.ts';
import {withRestoreTaskInvocation as legacyTaskInvocation} from './workspace-restore-invocation.ts';
import {getOpacityCandidateAssembly} from './opacity-candidate-store.ts';
import {createOpacityCandidateDomain} from './opacity-candidate-domain.ts';
import {isOpacityCandidateServicesForStore} from './opacity-candidate-services.ts';
import {randomUUID} from 'node:crypto';
import {withTimelineFormatTaskDispatch} from './timeline-format-task-context.ts';
import {isProxy} from 'node:util/types';
import {AppError, schemas, publicValue, DURABLE_EDIT_OPERATIONS, EDIT_TASK_LIMITS, editTaskLane, isEditTask, hasRequestNotAppliedProof} from '@mioon/contracts';
import {hash} from './services.ts';
import {ownsStoreLock} from './db.ts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {readTimelineReceipt, createTimelineRecoveryBoundary as legacyTimelineBoundary} from './timeline-recovery.ts';
import {readReferenceReceipt, createReferenceRecoveryBoundary} from './reference-recovery.ts';
import {readSubjectReceipt} from './subject-recovery.ts';
import {createSubjectRecoveryBoundary} from './subjects.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {TimelineRecoveryBoundary,TimelineRecoveryInput,TimelineReceiptRow} from './timeline-recovery.ts';
import type {TimelineRecord} from './timeline-inputs.ts';

type EditTaskRow = {
 position: number;revision: number;acknowledged: number;bytes: number;id: string;projectId: string;operation: string;
 input: string;requestId: string;digest: string;lane: string;origin: string;status: string;
 claim: string|null;claimInstance: string|null;receiptDigest: string|null;errorCode: string|null;
 createdAt: string;updatedAt: string;executionEpoch?: string;
};
type TaskRecord = {
 id:string;projectId:string;operation:string;input: Record<string,unknown>;requestId:string;digest:string;lane:string;
 status:string;revision:number;createdAt:string;updatedAt:string;acknowledged:boolean;origin:string;errorCode?: string|null;
};
type PreparedIntent = {input: Record<string,unknown>&{projectId:string;requestId:string};text:string;requestId:string;digest:string;lane:string};
type DecodedTask = {row: EditTaskRow;task: TaskRecord};
type EditServices = {call: (operation: string,input: unknown)=>unknown};
interface EditTaskStore {db: DatabaseSync;tx: <T>(callback: ()=>T)=>T;root?: string}
interface EditTaskDeps {store: EditTaskStore;services: EditServices;fault?: (label: string)=>unknown;limits?: Record<string,number>}
interface UpdateOptions {claim?: string|null;claimInstance?: string|null;receiptDigest?: string|null;errorCode?: string|null;acknowledged?: number}
type SubjectRecoveryBoundaryLike = {context(operation: string): void;replay(operation: string,response: unknown): unknown};
const wellFormed=(value: string): boolean=>(value as unknown as {isWellFormed(): boolean}).isWellFormed();

const errors: Readonly<Record<string,[number,string]>>=Object.freeze({
 TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED: [409, '当前工作区不支持时间线音量包络。'],
 EDIT_TASK_VALIDATION: [400, '编辑任务参数无效。'], EDIT_TASK_LIMIT: [413, '编辑意图超过 8 KiB 限制。'],
 EDIT_TASK_NOT_FOUND: [404, '项目或编辑任务不存在。'], EDIT_TASK_CONFLICT: [409, '编辑任务内容、版本或恢复通道已改变，请重新查看。'],
 EDIT_TASK_STALE_INSTANCE: [409, '后端已重新启动，请重新读取任务后显式恢复。'],
 EDIT_TASK_OWNER_REQUIRED: [403, '只有持有工作区锁的后端可以修改编辑任务。'],
 EDIT_TASK_STORAGE_LIMIT: [507, '编辑任务保留容量已满（最多 4096 个身份、64 MiB 逻辑预留）。已完成身份仍保留，不能自动清理；这不表示磁盘已满。'],
 EDIT_TASK_STORAGE_UNAVAILABLE: [503, '无法安全读取或保存编辑任务。'],
});
export const editTaskError = (code: string): AppError => { const restore=safeWorkspaceRestoreError({code});if(restore)return restore as AppError;const key = Object.hasOwn(errors, code) ? code : 'EDIT_TASK_STORAGE_UNAVAILABLE'; const entry=errors[key]; return new AppError(key, entry[1], entry[0]); };
export function safeEditTaskError(error: unknown) { const safe = editTaskError((error as {code?: string}|null|undefined)?.code as string); return {status: safe.status, code: safe.code, message: safe.message}; }
const fail: (code: string)=>never = code => { throw editTaskError(code); };
const corrupt: ()=>never = () => fail('EDIT_TASK_STORAGE_UNAVAILABLE');
const invalid: ()=>never = () => fail('EDIT_TASK_VALIDATION');
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length===36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown): boolean => typeof value === 'string' && value.length===64 && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
const timestamp = (): string => new Date().toISOString();
const terminal = (row: EditTaskRow): boolean => row.status === 'applied' || row.status === 'not_applied';
const lifetimes = new WeakMap<DatabaseSync,{instanceId: string;active: Set<string|null>}>();
const bounded = (column: string, bytes: number): string => `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END AS ${column}`;
const columns = ['position','revision','acknowledged','bytes', ...Object.entries({id:36,projectId:36,operation:80,input:8192,requestId:800,digest:64,lane:32,origin:32,status:32,claim:36,claimInstance:36,receiptDigest:64,errorCode:80,createdAt:40,updatedAt:40}).map(([key,bytes]) => bounded(key,bytes))].join(',');

// Inspect data properties before serialization. No getter, toJSON, proxy,
// undefined omission, or lossy non-JSON number can alter the captured intent.
function plain(value: unknown, depth = 0, budget: {nodes: number} = {nodes: 0}, arrayPath: readonly string[]|null = null, path: readonly string[] = []): unknown {
 if (++budget.nodes > 128 || depth > 8) invalid();
 if (value === null || typeof value === 'boolean') return value;
 if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
 if (typeof value === 'string') { if (value.length > EDIT_TASK_LIMITS.inputBytes || !wellFormed(value)) invalid(); return value; }
 if (!value || typeof value !== 'object' || isProxy(value)) invalid();
 if (Array.isArray(value)) {
  // No generic array permission: only the selected add/update points path.
  if (arrayPath===null || path.length!==arrayPath.length || path.some((key,index)=>key!==arrayPath[index]) || Object.getPrototypeOf(value)!==Array.prototype) invalid();
  const length=Object.getOwnPropertyDescriptor(value,'length');
  if(!length || !Object.hasOwn(length,'value') || !Number.isSafeInteger(length.value) || (length.value as number)<1 || (length.value as number)>16 || Reflect.ownKeys(value).length!==(length.value as number)+1) invalid();
  const result: unknown[]=[];
  for(let index=0;index<(length.value as number);index++) {
   const entry=Object.getOwnPropertyDescriptor(value,String(index));
   if(!entry?.enumerable || !Object.hasOwn(entry,'value')) invalid();
   result.push(plain(entry.value,depth+1,budget,arrayPath,[...path,String(index)]));
  }
  return result;
 }
 if (![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
 const result: Record<string, unknown> = {};
 for (const key of Reflect.ownKeys(value)) {
  const entry = Object.getOwnPropertyDescriptor(value,key);
  if (typeof key !== 'string' || !wellFormed(key) || key === '__proto__' || !entry?.enumerable || !Object.hasOwn(entry,'value')) invalid();
  result[key] = plain(entry.value,depth+1,budget,arrayPath,[...path,key]);
 }
 return result;
}
const envelopeArrayPath = (operation: string): string[]|null => operation==='timeline.clip.add'?['volumeEnvelope','points']:operation==='timeline.clip.update'?['patch','volumeEnvelope','points']:null;
function fields(value: unknown, required: string[], optional: string[] = [], arrayPath: string[]|null = null): Record<string, unknown> {
 const result = plain(value,0,{nodes:0},arrayPath);
 const record=result as Record<string, unknown>;
 if (!record || typeof record !== 'object' || required.some((key: string) => !Object.hasOwn(record,key)) || Object.keys(record).some((key: string) => !required.includes(key) && !optional.includes(key))) invalid();
 return record;
}

function prepareFields(value: unknown): {projectId: string;operation: string;input: Record<string, unknown>;origin: string} {
 // Inspect operation without invoking a getter/proxy before selecting a path.
 if (!value || typeof value!=='object' || isProxy(value) || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
 const descriptor=Object.getOwnPropertyDescriptor(value,'operation');
 if(!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) invalid();
 const path=envelopeArrayPath(descriptor.value as string);
 return fields(value,['projectId','operation','input','origin'],[],path?['input',...path]:null) as {projectId: string;operation: string;input: Record<string, unknown>;origin: string};
}

/** Additive local UI intent ledger. The domain journals remain authoritative.
 * Claims commit before dispatch, and dispatch always uses the original shared
 * service outside a coordinator transaction. No model/RPC capability is added. */
export function createEditTasks({store, services, fault = () => {}, limits = {}}: EditTaskDeps) {
 if (!store?.db || typeof store.tx !== 'function' || typeof services?.call !== 'function' || typeof fault !== 'function') corrupt();
 const opacity=getOpacityCandidateAssembly(store),domain=opacity?createOpacityCandidateDomain(store):null;
 if(opacity&&!isOpacityCandidateServicesForStore(store,services))corrupt();
 const restored=opacity?opacity.getRestoreContext():legacyRestoreContext(store);
 const refuseRestoredTask=(target: unknown,taskId?: string,projectId?: string): void=>{
  if(opacity){opacity.refuseTask(taskId,projectId);return;}
  legacyRefuseTask(target as never,taskId,projectId);
 };
 const assertWorkspaceRestoreOrigin=(target: unknown,context: Record<string,unknown>): unknown=>{
  if(opacity)return opacity.assertOrigin(context);
  return legacyAssertOrigin(target as never,context);
 };
 const assertRestoreRequestVacant=(target: unknown,operation: string,input: Record<string,unknown>): void=>{
  if(opacity){opacity.assertRequestVacant(operation,input);return;}
  legacyRequestVacant(target as never,operation,input);
 };
 const withRestoreTaskInvocation=(target: unknown,row: EditTaskRow,options: {signal?: AbortSignal},callback: ()=>unknown): unknown=>{
  if(opacity)return opacity.withTaskInvocation(row,options,callback);
  return legacyTaskInvocation(target as never,row as never,options,callback);
 };
 const createTimelineRecoveryBoundary=(target: DatabaseSync,input: Record<string,unknown>): TimelineRecoveryBoundary=>domain?domain.boundary(input) as unknown as TimelineRecoveryBoundary:legacyTimelineBoundary(target,input as TimelineRecoveryInput);
 const select=`SELECT ${columns}${restored?',executionEpoch':''} FROM edit_tasks`;
 const {db} = store, bounds: Record<string,number> = {...EDIT_TASK_LIMITS,...limits};
 for (const key of Object.keys(EDIT_TASK_LIMITS)) if (!integer(bounds[key]) || bounds[key] > (EDIT_TASK_LIMITS as Readonly<Record<string,number>>)[key]) invalid();
 if (bounds.rowBytes !== EDIT_TASK_LIMITS.rowBytes || bounds.pageSize > bounds.maxPageSize) invalid();
 let life = lifetimes.get(db); if (!life) { life = {instanceId:randomUUID(), active:new Set<string|null>()}; lifetimes.set(db,life); }
 const {instanceId} = life, active = new Set<Promise<unknown>>(), lifetime=new AbortController(); let closing = false;
 const open = (): void => { if (closing) corrupt(); };
 const owner = (): void => { if (!(opacity?opacity.ownsLock():ownsStoreLock(store))) fail('EDIT_TASK_OWNER_REQUIRED'); };
 const inject = (label: string): void => { const result = fault(label); if (result && typeof (result as PromiseLike<unknown>).then === 'function') { (result as PromiseLike<unknown> & {catch?: (callback: ()=>void)=>unknown}).catch?.(()=>{}); corrupt(); } };
 const guarded = <T>(fn: ()=>T): T => { try { return fn(); } catch (error) { throw editTaskError((error as {code?: string})?.code as string); } };
 const readOnly = <T>(fn: ()=>T): T => {
  if (db.isTransaction) corrupt();
  db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
 };
 const project = (projectId: string): void => { if (!uuid(projectId)) invalid(); if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) fail('EDIT_TASK_NOT_FOUND'); createOwnedMediaGraphReader(db,projectId); };
 function parseIntent(operation: string, input: unknown, projectId: string): PreparedIntent {
  if (!DURABLE_EDIT_OPERATIONS.includes(operation) || !uuid(projectId)) invalid();
  let exact: Record<string, unknown>&{projectId?: unknown;requestId?: unknown};
  if(domain){try{exact=domain.captureIntent(operation,input).input as Record<string, unknown>;}catch{invalid();}}
  else exact=plain(input,0,{nodes:0},envelopeArrayPath(operation)) as Record<string, unknown>;
  const text = JSON.stringify(exact);
  if (Buffer.byteLength(text) > bounds.inputBytes) fail('EDIT_TASK_LIMIT');
  const schema=(schemas as Record<string,{safeParse(value: unknown):{success: boolean}}>)[operation];
  if (exact.projectId !== projectId || !domain&&!schema.safeParse(exact).success) invalid();
  if(!domain){assertTimelineAudioRoleWorkspace(db,exact);assertTimelineVolumeEnvelopeWorkspace(db,exact);}
  return {input:exact as Record<string,unknown>&{projectId:string;requestId:string},text,requestId:exact.requestId as string,digest:hash({operation,input:exact}),lane:editTaskLane(operation) as string};
 }
 function decode(row: EditTaskRow|undefined, projectId: string): DecodedTask {
  if (!row || row.projectId !== projectId) fail('EDIT_TASK_NOT_FOUND');
  project(projectId);
  if (typeof row.input !== 'string') corrupt();
  let input: Record<string, unknown>|undefined; try { input = JSON.parse(row.input); } catch { corrupt(); }
  let intent: PreparedIntent|undefined; try { intent = parseIntent(row.operation,input,projectId); } catch { corrupt(); }
  if(!input||!intent)corrupt();
  const task: TaskRecord = {id:row.id,projectId:row.projectId,operation:row.operation,input,requestId:row.requestId,digest:row.digest,lane:row.lane,
   status:row.status,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,acknowledged:row.acknowledged===1,origin:row.origin,
   ...(row.errorCode===null?{}:{errorCode:row.errorCode})};
  if (!(domain?domain.isTask(task):isEditTask(task)) || !integer(row.position) || row.bytes!==EDIT_TASK_LIMITS.rowBytes || ![0,1].includes(row.acknowledged as number) ||
      intent.digest!==row.digest || intent.requestId!==row.requestId || intent.lane!==row.lane ||
      (row.claim===null)!==(row.claimInstance===null) || row.claim!==null&&(!uuid(row.claim)||!uuid(row.claimInstance)) ||
      (row.status==='applied')!==(row.receiptDigest!==null) || row.receiptDigest!==null&&!digest(row.receiptDigest) ||
      (row.status==='not_applied')!==(row.errorCode!==null) || row.status==='dispatching'&&row.claim===null ||
      row.status==='prepared'&&(row.origin!=='new'||row.claim!==null)) corrupt();
  if(restored&&row.executionEpoch!=='captured'&&row.executionEpoch!==restored.workspaceOrigin)corrupt();
  if (row.status==='not_applied' && !hasRequestNotAppliedProof({code:row.errorCode,status:409,details:{mutationOutcome:'not_applied',operation:row.operation,projectId,requestId:row.requestId}},input,{operation:row.operation})) corrupt();
  return {row,task};
 }
 const byId = (projectId: string,taskId: string): DecodedTask => decode(db.prepare(`${select} WHERE id=? AND projectId=?`).get(taskId,projectId) as EditTaskRow|undefined,projectId);
 function receipt(value: DecodedTask): unknown {
  const {row,task} = value, {operation,input} = task;
  // The new subject family checks current input ownership before consulting
  // its retained receipt. Never route an unknown family through reference.
  const subject: SubjectRecoveryBoundaryLike|null = row.lane==='subject:mutation' ? createSubjectRecoveryBoundary(db,input as never) as SubjectRecoveryBoundaryLike : null;
  if (subject) subject.context(operation);
  let saved: {requestHash?: string;response?: string}|null|undefined;
  switch (row.lane) {
   case 'timeline:mutation': saved=readTimelineReceipt(db,input as TimelineRecoveryInput,operation) as TimelineReceiptRow|undefined; break;
   case 'reference:mutation': saved=readReferenceReceipt(db,input as never) as {requestHash?: string;response?: string}|null; break;
   case 'subject:mutation': saved=readSubjectReceipt(db,input as never,operation) as {requestHash?: string;response?: string}|null; break;
   default: corrupt();
  }
  if (!saved) return null;
  if (saved.requestHash!==hash({operation,input})) fail('EDIT_TASK_CONFLICT');
  let response;
  switch (row.lane) {
   case 'timeline:mutation': response=createTimelineRecoveryBoundary(db,input).replay(operation,saved.response as string); break;
   case 'reference:mutation': response=createReferenceRecoveryBoundary(db,input as never).replay(operation,saved.response as string); break;
   case 'subject:mutation': response=subject!.replay(operation,saved.response); break;
   default: corrupt();
  }
  if (row.receiptDigest!==null && row.receiptDigest!==hash(response)) corrupt();
  return publicValue(response);
 }
 function ownership(value: DecodedTask): void {
  const {row,task} = value, {input} = task;
  if (row.lane==='timeline:mutation') {
   const boundary=createTimelineRecoveryBoundary(db,input); boundary.read();
   if(input.assetId)boundary.inputAsset(input.assetId as string);
   if(input.versionId)boundary.version(input.versionId as string,undefined,input.assetId as string);
  } else if (row.lane==='reference:mutation') {
   const boundary=createReferenceRecoveryBoundary(db,input as never); boundary.project();
   if (task.operation==='reference.attach') { boundary.node(input.sourceNodeId as string); boundary.shot(input.targetShotId as string); }
   else boundary.edge(input.edgeId as string,{optional:true});
  } else if (row.lane==='subject:mutation') {
   createSubjectRecoveryBoundary(db,input as never).context(task.operation);
  } else corrupt();
 }
 function envelope(value: DecodedTask, includeResult = false): unknown {
  // Historical replay, rather than current target equality, validates retained
  // outcomes after undo, deleted clips, detached edges and rebinding.
  const result = receipt(value);
  if (value.row.status==='applied' && result===null || value.row.status==='not_applied' && result!==null) corrupt();
  if (result===null) ownership(value);
  return {task:value.task,instanceId,...(restored?{restore:{workspaceOrigin:restored.workspaceOrigin,executionEpoch:value.row.executionEpoch,held:value.row.executionEpoch!==restored.workspaceOrigin}}:{}),...(includeResult&&value.row.status==='applied'?{result}: {})};
 }
 function action(input: unknown, extra: string[] = []): {args: Record<string,unknown>;value:DecodedTask} {
  const args=fields(input,['projectId','taskId','digest',...extra]);
  if (!uuid(args.projectId)||!uuid(args.taskId)||!digest(args.digest)) invalid();
  const value=byId(args.projectId as string,args.taskId as string); if(value.row.digest!==args.digest)fail('EDIT_TASK_CONFLICT');
  return {args,value};
 }
 function update(value: DecodedTask,status: string,{claim=value.row.claim,claimInstance=value.row.claimInstance,receiptDigest=value.row.receiptDigest,errorCode=value.row.errorCode,acknowledged=value.row.acknowledged}: UpdateOptions={}): DecodedTask {
  const {row}=value;
  const result=db.prepare('UPDATE edit_tasks SET status=?,revision=revision+1,claim=?,claimInstance=?,receiptDigest=?,errorCode=?,acknowledged=?,updatedAt=? WHERE id=? AND revision=?')
   .run(status,claim,claimInstance,receiptDigest,errorCode,acknowledged,timestamp(),row.id,row.revision);
  if(result.changes!==1)fail('EDIT_TASK_CONFLICT');
  return byId(row.projectId,row.id);
 }
 function applied(value: DecodedTask,result: unknown): DecodedTask { return update(value,'applied',{receiptDigest:hash(result)}); }
 function dispatch(operation: string,input: Record<string,unknown>,value: DecodedTask): unknown {
  switch(operation) {
   case 'timeline.loudness.apply': return services.call('timeline.loudness.apply',input);
   case 'timeline.format.set': return withTimelineFormatTaskDispatch(db,value.row,()=>services.call('timeline.format.set',input));
   case 'timeline.subtitle.add': return services.call('timeline.subtitle.add',input);
   case 'timeline.subtitle.update': return services.call('timeline.subtitle.update',input);
   case 'timeline.subtitle.remove': return services.call('timeline.subtitle.remove',input);
   case 'timeline.track.add': return services.call('timeline.track.add',input);
   case 'timeline.track.update': return services.call('timeline.track.update',input);
   case 'timeline.clip.add': return services.call('timeline.clip.add',input);
   case 'timeline.clip.update': return services.call('timeline.clip.update',input);
   case 'timeline.clip.replaceSource': return services.call('timeline.clip.replaceSource',input);
   case 'timeline.clip.remove': return services.call('timeline.clip.remove',input);
   case 'timeline.clip.rippleRemove': return services.call('timeline.clip.rippleRemove',input);
   case 'timeline.clip.split': return services.call('timeline.clip.split',input);
   case 'timeline.seed': return services.call('timeline.seed',input);
   case 'timeline.undo': return services.call('timeline.undo',input);
   case 'timeline.redo': return services.call('timeline.redo',input);
   case 'reference.attach': return services.call('reference.attach',input);
   case 'reference.detach': return services.call('reference.detach',input);
   case 'subject.create': return services.call('subject.create',input);
   case 'subject.version.add': return services.call('subject.version.add',input);
   case 'subject.binding.set': return services.call('subject.binding.set',input);
   default: invalid();
  }
 }
 const methods = {
  prepare(input: unknown,context: Record<string,unknown>={}) { return guarded(()=>{
   open();owner();
   // Private storage59 preserves captured history only; do not persist a new
   // executable intent before the shared domain dispatch can reject it.
   if(restored&&!opacity&&readCurrentWorkspaceRole(db)==='storage-private-59-evidence')refuseRestoredTask(store);
   let args: {projectId: string;operation: string;input: Record<string,unknown>;origin: string};
   if(domain){try{args=domain.capturePrepare(input) as unknown as typeof args;}catch{invalid();}}else args=prepareFields(input);
   if(!['new','legacy_session'].includes(args.origin))invalid();
   if(restored&&args.operation==='timeline.clip.rippleRemove'&&(opacity?!opacity.rippleRemove:![45,49,51,53,55,57,59,61,63].includes(restored.schemaVersion)))refuseRestoredTask(store);
   const intent=parseIntent(args.operation,args.input,args.projectId);
   if(restored){project(args.projectId);assertWorkspaceRestoreOrigin(store,context);if(args.origin!=='new')refuseRestoredTask(store);assertRestoreRequestVacant(store,args.operation,intent.input);if(args.operation==='timeline.loudness.apply')refuseRestoredTask(store);}
   const result=store.tx(()=>{
    owner();project(args.projectId);
    const prior=db.prepare(`${select} WHERE lane=? AND requestId=?`).get(intent.lane,intent.requestId) as EditTaskRow|undefined;
    if(prior) {
     if(prior.projectId!==args.projectId||prior.operation!==args.operation||prior.digest!==intent.digest)fail('EDIT_TASK_CONFLICT');
     return envelope(decode(prior,args.projectId));
    }
    if(db.prepare(`SELECT 1 FROM edit_tasks WHERE projectId=? AND lane=? AND acknowledged=0 ${restored?'AND executionEpoch=?':''} LIMIT 1`).get(args.projectId,intent.lane,...(restored?[restored.workspaceOrigin]:[])))fail('EDIT_TASK_CONFLICT');
    const quota=db.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM edit_tasks').get() as {rows: number;bytes: number};
    if(quota.rows>=bounds.rows||quota.bytes+EDIT_TASK_LIMITS.rowBytes>bounds.bytes)fail('EDIT_TASK_STORAGE_LIMIT');
    const now=timestamp(),id=randomUUID(),status=args.origin==='new'?'prepared':'unknown';
    inject('beforePreparePersist');
    db.prepare(`INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes${restored?',executionEpoch':''}) VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?,?${restored?',?':''})`)
     .run(id,args.projectId,args.operation,intent.text,intent.requestId,intent.digest,intent.lane,args.origin,status,now,now,EDIT_TASK_LIMITS.rowBytes,...(restored?[restored.workspaceOrigin]:[]));
    return envelope(byId(args.projectId,id));
   });
   inject('afterPreparePersist');return result;
  }); },
  get(input: unknown) { return guarded(()=>{
   open();const args=fields(input,['projectId','taskId']);if(!uuid(args.projectId)||!uuid(args.taskId))invalid();
   return readOnly(()=>envelope(byId(args.projectId as string,args.taskId as string)));
  }); },
  list(input: unknown) { return guarded(()=>{
   open();const args=fields(input,['projectId'],['pendingOnly','limit','cursor']);
   if(!uuid(args.projectId)||args.pendingOnly!==undefined&&typeof args.pendingOnly!=='boolean')invalid();
   const pendingOnly=args.pendingOnly??true,limit=(args.limit??bounds.pageSize) as number;
   if(!integer(limit)||limit>bounds.maxPageSize)invalid();
   let before: number=Number.MAX_SAFE_INTEGER;
   if(args.cursor!==undefined){
    if(typeof args.cursor!=='string'||args.cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(args.cursor))invalid();
    let decoded;try{decoded=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));}catch{invalid();}
    if(!Array.isArray(decoded)||decoded.length!==3||decoded[0]!==args.projectId||decoded[1]!==pendingOnly||!integer(decoded[2]))invalid();before=decoded[2] as number;
   }
   return readOnly(()=>{
    project(args.projectId as string);
    const rows=db.prepare(`${select} WHERE projectId=? ${pendingOnly?'AND acknowledged=0':''} ${pendingOnly&&restored?'AND executionEpoch=?':''} AND position<? ORDER BY position DESC LIMIT ?`).all(args.projectId as string,...(pendingOnly&&restored?[restored.workspaceOrigin]:[]),before,limit+1) as EditTaskRow[];
    const items=rows.slice(0,limit).map((row: EditTaskRow)=>(envelope(decode(row,args.projectId as string)) as {task: unknown}).task);
    return {items,nextCursor:rows.length>limit?Buffer.from(JSON.stringify([args.projectId,pendingOnly,rows[limit-1].position])).toString('base64url'):null,instanceId,...(restored?{restore:{workspaceOrigin:restored.workspaceOrigin,tasks:rows.slice(0,limit).map((row: EditTaskRow)=>({taskId:row.id,executionEpoch:row.executionEpoch,held:row.executionEpoch!==restored.workspaceOrigin}))}}:{})};
   });
  }); },
  execute(input: unknown,context: Record<string,unknown>={}) {
   const work=(async()=>{
    open();owner();if(restored){
     const {args,value}=action(input,['instanceId']);
     if(!uuid(args.instanceId))invalid();
     if(value.row.executionEpoch!==restored.workspaceOrigin)refuseRestoredTask(store,value.row.id,value.row.projectId);
     assertWorkspaceRestoreOrigin(store,context);
    }let claimed: DecodedTask|undefined;
    const initial=store.tx(()=>{
     owner();const {args,value}=action(input,['instanceId']);
     if(!uuid(args.instanceId))invalid();if(args.instanceId!==instanceId)fail('EDIT_TASK_STALE_INSTANCE');
     if(terminal(value.row)||value.row.status==='dispatching')return envelope(value,true);
     const result=receipt(value);if(result!==null)return envelope(applied(value,result),true);
     ownership(value);claimed=update(value,'dispatching',{claim:randomUUID(),claimInstance:instanceId});
     life.active.add(claimed.row.claim);return null;
    });
    if(initial)return initial;
    try {
     inject('afterClaim');inject('beforeDispatch');owner();
     if(!claimed)corrupt();
     let dispatchError: unknown;
     try { await (restored?withRestoreTaskInvocation(store,claimed.row,{signal:lifetime.signal},()=>dispatch(claimed!.task.operation,structuredClone(claimed!.task.input) as Record<string,unknown>,claimed!)):dispatch(claimed.task.operation,structuredClone(claimed.task.input) as Record<string,unknown>,claimed)); }
     catch(error){dispatchError=error;}
     inject('afterBusinessCommit');
     const finished=store.tx(()=>{
      owner();const claimedTask=claimed!;const current=byId(claimedTask.row.projectId,claimedTask.row.id);
      if(current.row.revision!==claimedTask.row.revision||current.row.claim!==claimedTask.row.claim||current.row.status!=='dispatching')return envelope(current,true);
      const result=receipt(current);let next;
      inject('beforeOutcomePersist');
      if(result!==null)next=applied(current,result);
      else {
       ownership(current);
       const rejected=hasRequestNotAppliedProof(dispatchError as never,current.task.input as never,{operation:current.task.operation} as never);
       next=update(current,rejected?'not_applied':'unknown',{errorCode:rejected?(dispatchError as {code:string}).code:null});
      }
      return envelope(next,true);
     });
     inject('afterOutcomePersist');return finished;
    } finally { if(claimed)life.active.delete(claimed.row.claim); }
   })().catch((error: unknown)=>{throw editTaskError((error as {code?: string})?.code as string);});
   active.add(work);work.then(()=>active.delete(work),()=>active.delete(work));return work;
  },
  reconcile(input: unknown,context: Record<string,unknown>={}) { return guarded(()=>{
   open();owner();if(restored){const {value}=action(input);if(value.row.executionEpoch!==restored.workspaceOrigin)refuseRestoredTask(store,value.row.id,value.row.projectId);assertWorkspaceRestoreOrigin(store,context);}return store.tx(()=>{
    owner();const {value}=action(input);
    if(terminal(value.row))return envelope(value,true);
    const result=receipt(value);
    if(result!==null)return envelope(applied(value,result),true);
    ownership(value);
    if(value.row.status==='dispatching'&&!life.active.has(value.row.claim))return envelope(update(value,'unknown'));
    return envelope(value);
   });
  }); },
  acknowledge(input: unknown,context: Record<string,unknown>={}) { return guarded(()=>{
   open();owner();if(restored){
    const {args,value}=action(input,['expectedRevision','status']);
    if(!integer(args.expectedRevision)||!['applied','not_applied'].includes(args.status as string))invalid();
    if(value.row.executionEpoch!==restored.workspaceOrigin)refuseRestoredTask(store,value.row.id,value.row.projectId);
    assertWorkspaceRestoreOrigin(store,context);
   }return store.tx(()=>{
    owner();const {args,value}=action(input,['expectedRevision','status']);
    if(!integer(args.expectedRevision)||!['applied','not_applied'].includes(args.status as string))invalid();
    if(!terminal(value.row)||value.row.status!==args.status||value.row.revision!==(args.expectedRevision as number))fail('EDIT_TASK_CONFLICT');
    envelope(value);
    return value.row.acknowledged?envelope(value):envelope(update(value,value.row.status,{acknowledged:1}));
   });
  }); },
  reconcileStartup() { return guarded(()=>{
   open();owner();let processed=0,unavailable=0,position=0;
   // The real exclusive owner may recover a previous lifetime only. A second
   // manager/reader cannot steal a live asynchronous claim.
   while(true){
    const rows=db.prepare(`SELECT position,${bounded('id',36)},${bounded('projectId',36)} FROM edit_tasks WHERE status='dispatching' ${restored?'AND executionEpoch=?':''} AND position>? ORDER BY position LIMIT 50`).all(...(restored?[restored.workspaceOrigin]:[]),position) as EditTaskRow[];
    if(!rows.length)break;
    for(const row of rows){position=row.position;try{store.tx(()=>{
     owner();const value=byId(row.projectId,row.id);
     if(value.row.status!=='dispatching'||value.row.claimInstance===instanceId||life.active.has(value.row.claim))return;
     const result=receipt(value);if(result!==null)applied(value,result);else{ownership(value);update(value,'unknown');}processed++;
    });}catch{unavailable++;}}
   }
   return {processed,unavailable};
  }); },
  async drain() { closing=true;lifetime.abort();await Promise.allSettled([...active]); },
 };
 return methods;
}
