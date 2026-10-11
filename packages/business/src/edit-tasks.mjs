import {randomUUID} from 'node:crypto';
import {withTimelineFormatTaskDispatch} from './timeline-format-task-context.mjs';
import {isProxy} from 'node:util/types';
import {AppError, schemas, publicValue, DURABLE_EDIT_OPERATIONS, EDIT_TASK_LIMITS, editTaskLane, isEditTask, hasRequestNotAppliedProof} from '@mioon/contracts';
import {hash} from './services.mjs';
import {ownsStoreLock} from './db.mjs';
import {createOwnedMediaGraphReader} from './inspection.mjs';
import {readTimelineReceipt, createTimelineRecoveryBoundary} from './timeline-recovery.mjs';
import {readReferenceReceipt, createReferenceRecoveryBoundary} from './reference-recovery.mjs';
import {readSubjectReceipt} from './subject-recovery.mjs';
import {createSubjectRecoveryBoundary} from './subjects.mjs';

const errors = Object.freeze({
 EDIT_TASK_VALIDATION: [400, '编辑任务参数无效。'], EDIT_TASK_LIMIT: [413, '编辑意图超过 8 KiB 限制。'],
 EDIT_TASK_NOT_FOUND: [404, '项目或编辑任务不存在。'], EDIT_TASK_CONFLICT: [409, '编辑任务内容、版本或恢复通道已改变，请重新查看。'],
 EDIT_TASK_STALE_INSTANCE: [409, '后端已重新启动，请重新读取任务后显式恢复。'],
 EDIT_TASK_OWNER_REQUIRED: [403, '只有持有工作区锁的后端可以修改编辑任务。'],
 EDIT_TASK_STORAGE_LIMIT: [507, '编辑任务保留容量已满（最多 4096 个身份、64 MiB 逻辑预留）。已完成身份仍保留，不能自动清理；这不表示磁盘已满。'],
 EDIT_TASK_STORAGE_UNAVAILABLE: [503, '无法安全读取或保存编辑任务。'],
});
export const editTaskError = code => { const key = Object.hasOwn(errors, code) ? code : 'EDIT_TASK_STORAGE_UNAVAILABLE'; return new AppError(key, errors[key][1], errors[key][0]); };
export function safeEditTaskError(error) { const safe = editTaskError(error?.code); return {status: safe.status, code: safe.code, message: safe.message}; }
const fail = code => { throw editTaskError(code); };
const corrupt = () => fail('EDIT_TASK_STORAGE_UNAVAILABLE');
const invalid = () => fail('EDIT_TASK_VALIDATION');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const timestamp = () => new Date().toISOString();
const terminal = row => row.status === 'applied' || row.status === 'not_applied';
const lifetimes = new WeakMap();
const bounded = (column, bytes) => `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END AS ${column}`;
const columns = ['position','revision','acknowledged','bytes', ...Object.entries({id:36,projectId:36,operation:80,input:8192,requestId:800,digest:64,lane:32,origin:32,status:32,claim:36,claimInstance:36,receiptDigest:64,errorCode:80,createdAt:40,updatedAt:40}).map(([key,bytes]) => bounded(key,bytes))].join(',');
const select = `SELECT ${columns} FROM edit_tasks`;

// Inspect data properties before serialization. No getter, toJSON, proxy,
// undefined omission, or lossy non-JSON number can alter the captured intent.
function plain(value, depth = 0, budget = {nodes: 0}) {
 if (++budget.nodes > 128 || depth > 8) invalid();
 if (value === null || typeof value === 'boolean') return value;
 if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
 if (typeof value === 'string') { if (value.length > EDIT_TASK_LIMITS.inputBytes || !value.isWellFormed()) invalid(); return value; }
 if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
 const result = {};
 for (const key of Reflect.ownKeys(value)) {
  const entry = Object.getOwnPropertyDescriptor(value,key);
  if (typeof key !== 'string' || key === '__proto__' || !entry?.enumerable || !Object.hasOwn(entry,'value')) invalid();
  result[key] = plain(entry.value,depth+1,budget);
 }
 return result;
}
function fields(value, required, optional = []) {
 const result = plain(value);
 if (!result || typeof result !== 'object' || required.some(key => !Object.hasOwn(result,key)) || Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) invalid();
 return result;
}

/** Additive local UI intent ledger. The domain journals remain authoritative.
 * Claims commit before dispatch, and dispatch always uses the original shared
 * service outside a coordinator transaction. No model/RPC capability is added. */
export function createEditTasks({store, services, fault = () => {}, limits = {}}) {
 if (!store?.db || typeof store.tx !== 'function' || typeof services?.call !== 'function' || typeof fault !== 'function') corrupt();
 const {db} = store, bounds = {...EDIT_TASK_LIMITS,...limits};
 for (const key of Object.keys(EDIT_TASK_LIMITS)) if (!integer(bounds[key]) || bounds[key] > EDIT_TASK_LIMITS[key]) invalid();
 if (bounds.rowBytes !== EDIT_TASK_LIMITS.rowBytes || bounds.pageSize > bounds.maxPageSize) invalid();
 let life = lifetimes.get(db); if (!life) { life = {instanceId:randomUUID(), active:new Set()}; lifetimes.set(db,life); }
 const {instanceId} = life, active = new Set(); let closing = false;
 const open = () => { if (closing) corrupt(); };
 const owner = () => { if (!ownsStoreLock(store)) fail('EDIT_TASK_OWNER_REQUIRED'); };
 const inject = label => { const result = fault(label); if (result && typeof result.then === 'function') { result.catch?.(()=>{}); corrupt(); } };
 const guarded = fn => { try { return fn(); } catch (error) { throw editTaskError(error?.code); } };
 const readOnly = fn => {
  if (db.isTransaction) corrupt();
  db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
 };
 const project = projectId => { if (!uuid(projectId)) invalid(); if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) fail('EDIT_TASK_NOT_FOUND'); createOwnedMediaGraphReader(db,projectId); };
 function parseIntent(operation, input, projectId) {
  if (!DURABLE_EDIT_OPERATIONS.includes(operation) || !uuid(projectId)) invalid();
  const exact = plain(input), text = JSON.stringify(exact);
  if (Buffer.byteLength(text) > bounds.inputBytes) fail('EDIT_TASK_LIMIT');
  if (!schemas[operation].safeParse(exact).success || exact.projectId !== projectId) invalid();
  return {input:exact,text,requestId:exact.requestId,digest:hash({operation,input:exact}),lane:editTaskLane(operation)};
 }
 function decode(row, projectId) {
  if (!row || row.projectId !== projectId) fail('EDIT_TASK_NOT_FOUND');
  project(projectId);
  if (typeof row.input !== 'string') corrupt();
  let input; try { input = JSON.parse(row.input); } catch { corrupt(); }
  let intent; try { intent = parseIntent(row.operation,input,projectId); } catch { corrupt(); }
  const task = {id:row.id,projectId:row.projectId,operation:row.operation,input,requestId:row.requestId,digest:row.digest,lane:row.lane,
   status:row.status,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,acknowledged:row.acknowledged===1,origin:row.origin,
   ...(row.errorCode===null?{}:{errorCode:row.errorCode})};
  if (!isEditTask(task) || !integer(row.position) || row.bytes!==EDIT_TASK_LIMITS.rowBytes || ![0,1].includes(row.acknowledged) ||
      intent.digest!==row.digest || intent.requestId!==row.requestId || intent.lane!==row.lane ||
      (row.claim===null)!==(row.claimInstance===null) || row.claim!==null&&(!uuid(row.claim)||!uuid(row.claimInstance)) ||
      (row.status==='applied')!==(row.receiptDigest!==null) || row.receiptDigest!==null&&!digest(row.receiptDigest) ||
      (row.status==='not_applied')!==(row.errorCode!==null) || row.status==='dispatching'&&row.claim===null ||
      row.status==='prepared'&&(row.origin!=='new'||row.claim!==null)) corrupt();
  if (row.status==='not_applied' && !hasRequestNotAppliedProof({code:row.errorCode,status:409,details:{mutationOutcome:'not_applied',operation:row.operation,projectId,requestId:row.requestId}},input,{operation:row.operation})) corrupt();
  return {row,task};
 }
 const byId = (projectId,taskId) => decode(db.prepare(`${select} WHERE id=? AND projectId=?`).get(taskId,projectId),projectId);
 function receipt(value) {
  const {row,task} = value, {operation,input} = task;
  // The new subject family checks current input ownership before consulting
  // its retained receipt. Never route an unknown family through reference.
  const subject = row.lane==='subject:mutation' ? createSubjectRecoveryBoundary(db,input) : null;
  if (subject) subject.context(operation);
  let saved;
  switch (row.lane) {
   case 'timeline:mutation': saved=readTimelineReceipt(db,input,operation); break;
   case 'reference:mutation': saved=readReferenceReceipt(db,input); break;
   case 'subject:mutation': saved=readSubjectReceipt(db,input,operation); break;
   default: corrupt();
  }
  if (!saved) return null;
  if (saved.requestHash!==hash({operation,input})) fail('EDIT_TASK_CONFLICT');
  let response;
  switch (row.lane) {
   case 'timeline:mutation': response=createTimelineRecoveryBoundary(db,input).replay(operation,saved.response); break;
   case 'reference:mutation': response=createReferenceRecoveryBoundary(db,input).replay(operation,saved.response); break;
   case 'subject:mutation': response=subject.replay(operation,saved.response); break;
   default: corrupt();
  }
  if (row.receiptDigest!==null && row.receiptDigest!==hash(response)) corrupt();
  return publicValue(response);
 }
 function ownership(value) {
  const {row,task} = value, {input} = task;
  if (row.lane==='timeline:mutation') {
   const boundary=createTimelineRecoveryBoundary(db,input); boundary.read();
   if(input.assetId)boundary.inputAsset(input.assetId);
   if(input.versionId)boundary.version(input.versionId,undefined,input.assetId);
  } else if (row.lane==='reference:mutation') {
   const boundary=createReferenceRecoveryBoundary(db,input); boundary.project();
   if (task.operation==='reference.attach') { boundary.node(input.sourceNodeId); boundary.shot(input.targetShotId); }
   else boundary.edge(input.edgeId,{optional:true});
  } else if (row.lane==='subject:mutation') {
   createSubjectRecoveryBoundary(db,input).context(task.operation);
  } else corrupt();
 }
 function envelope(value, includeResult = false) {
  // Historical replay, rather than current target equality, validates retained
  // outcomes after undo, deleted clips, detached edges and rebinding.
  const result = receipt(value);
  if (value.row.status==='applied' && result===null || value.row.status==='not_applied' && result!==null) corrupt();
  if (result===null) ownership(value);
  return {task:value.task,instanceId,...(includeResult&&value.row.status==='applied'?{result}: {})};
 }
 function action(input, extra = []) {
  const args=fields(input,['projectId','taskId','digest',...extra]);
  if (!uuid(args.projectId)||!uuid(args.taskId)||!digest(args.digest)) invalid();
  const value=byId(args.projectId,args.taskId); if(value.row.digest!==args.digest)fail('EDIT_TASK_CONFLICT');
  return {args,value};
 }
 function update(value,status,{claim=value.row.claim,claimInstance=value.row.claimInstance,receiptDigest=value.row.receiptDigest,errorCode=value.row.errorCode,acknowledged=value.row.acknowledged}={}) {
  const {row}=value;
  const result=db.prepare('UPDATE edit_tasks SET status=?,revision=revision+1,claim=?,claimInstance=?,receiptDigest=?,errorCode=?,acknowledged=?,updatedAt=? WHERE id=? AND revision=?')
   .run(status,claim,claimInstance,receiptDigest,errorCode,acknowledged,timestamp(),row.id,row.revision);
  if(result.changes!==1)fail('EDIT_TASK_CONFLICT');
  return byId(row.projectId,row.id);
 }
 function applied(value,result) { return update(value,'applied',{receiptDigest:hash(result)}); }
 function dispatch(operation,input,value) {
  switch(operation) {
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
  prepare(input) { return guarded(()=>{
   open();owner();const args=fields(input,['projectId','operation','input','origin']);
   if(!['new','legacy_session'].includes(args.origin))invalid();
   const intent=parseIntent(args.operation,args.input,args.projectId);
   const result=store.tx(()=>{
    owner();project(args.projectId);
    const prior=db.prepare(`${select} WHERE lane=? AND requestId=?`).get(intent.lane,intent.requestId);
    if(prior) {
     if(prior.projectId!==args.projectId||prior.operation!==args.operation||prior.digest!==intent.digest)fail('EDIT_TASK_CONFLICT');
     return envelope(decode(prior,args.projectId));
    }
    if(db.prepare('SELECT 1 FROM edit_tasks WHERE projectId=? AND lane=? AND acknowledged=0 LIMIT 1').get(args.projectId,intent.lane))fail('EDIT_TASK_CONFLICT');
    const quota=db.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM edit_tasks').get();
    if(quota.rows>=bounds.rows||quota.bytes+EDIT_TASK_LIMITS.rowBytes>bounds.bytes)fail('EDIT_TASK_STORAGE_LIMIT');
    const now=timestamp(),id=randomUUID(),status=args.origin==='new'?'prepared':'unknown';
    inject('beforePreparePersist');
    db.prepare('INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?,?)')
     .run(id,args.projectId,args.operation,intent.text,intent.requestId,intent.digest,intent.lane,args.origin,status,now,now,EDIT_TASK_LIMITS.rowBytes);
    return envelope(byId(args.projectId,id));
   });
   inject('afterPreparePersist');return result;
  }); },
  get(input) { return guarded(()=>{
   open();const args=fields(input,['projectId','taskId']);if(!uuid(args.projectId)||!uuid(args.taskId))invalid();
   return readOnly(()=>envelope(byId(args.projectId,args.taskId)));
  }); },
  list(input) { return guarded(()=>{
   open();const args=fields(input,['projectId'],['pendingOnly','limit','cursor']);
   if(!uuid(args.projectId)||args.pendingOnly!==undefined&&typeof args.pendingOnly!=='boolean')invalid();
   const pendingOnly=args.pendingOnly??true,limit=args.limit??bounds.pageSize;
   if(!integer(limit)||limit>bounds.maxPageSize)invalid();
   let before=Number.MAX_SAFE_INTEGER;
   if(args.cursor!==undefined){
    if(typeof args.cursor!=='string'||args.cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(args.cursor))invalid();
    let decoded;try{decoded=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));}catch{invalid();}
    if(!Array.isArray(decoded)||decoded.length!==3||decoded[0]!==args.projectId||decoded[1]!==pendingOnly||!integer(decoded[2]))invalid();before=decoded[2];
   }
   return readOnly(()=>{
    project(args.projectId);
    const rows=db.prepare(`${select} WHERE projectId=? ${pendingOnly?'AND acknowledged=0':''} AND position<? ORDER BY position DESC LIMIT ?`).all(args.projectId,before,limit+1);
    const items=rows.slice(0,limit).map(row=>envelope(decode(row,args.projectId)).task);
    return {items,nextCursor:rows.length>limit?Buffer.from(JSON.stringify([args.projectId,pendingOnly,rows[limit-1].position])).toString('base64url'):null,instanceId};
   });
  }); },
  execute(input) {
   const work=(async()=>{
    open();owner();let claimed;
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
     let dispatchError;
     try { await dispatch(claimed.task.operation,structuredClone(claimed.task.input),claimed); }
     catch(error){dispatchError=error;}
     inject('afterBusinessCommit');
     const finished=store.tx(()=>{
      owner();const current=byId(claimed.row.projectId,claimed.row.id);
      if(current.row.revision!==claimed.row.revision||current.row.claim!==claimed.row.claim||current.row.status!=='dispatching')return envelope(current,true);
      const result=receipt(current);let next;
      inject('beforeOutcomePersist');
      if(result!==null)next=applied(current,result);
      else {
       ownership(current);
       const rejected=hasRequestNotAppliedProof(dispatchError,current.task.input,{operation:current.task.operation});
       next=update(current,rejected?'not_applied':'unknown',{errorCode:rejected?dispatchError.code:null});
      }
      return envelope(next,true);
     });
     inject('afterOutcomePersist');return finished;
    } finally { life.active.delete(claimed.row.claim); }
   })().catch(error=>{throw editTaskError(error?.code);});
   active.add(work);work.then(()=>active.delete(work),()=>active.delete(work));return work;
  },
  reconcile(input) { return guarded(()=>{
   open();owner();return store.tx(()=>{
    owner();const {value}=action(input);
    if(terminal(value.row))return envelope(value,true);
    const result=receipt(value);
    if(result!==null)return envelope(applied(value,result),true);
    ownership(value);
    if(value.row.status==='dispatching'&&!life.active.has(value.row.claim))return envelope(update(value,'unknown'));
    return envelope(value);
   });
  }); },
  acknowledge(input) { return guarded(()=>{
   open();owner();return store.tx(()=>{
    owner();const {args,value}=action(input,['expectedRevision','status']);
    if(!integer(args.expectedRevision)||!['applied','not_applied'].includes(args.status))invalid();
    if(!terminal(value.row)||value.row.status!==args.status||value.row.revision!==args.expectedRevision)fail('EDIT_TASK_CONFLICT');
    envelope(value);
    return value.row.acknowledged?envelope(value):envelope(update(value,value.row.status,{acknowledged:1}));
   });
  }); },
  reconcileStartup() { return guarded(()=>{
   open();owner();let processed=0,unavailable=0,position=0;
   // The real exclusive owner may recover a previous lifetime only. A second
   // manager/reader cannot steal a live asynchronous claim.
   while(true){
    const rows=db.prepare(`SELECT position,${bounded('id',36)},${bounded('projectId',36)} FROM edit_tasks WHERE status='dispatching' AND position>? ORDER BY position LIMIT 50`).all(position);
    if(!rows.length)break;
    for(const row of rows){position=row.position;try{store.tx(()=>{
     owner();const value=byId(row.projectId,row.id);
     if(value.row.status!=='dispatching'||value.row.claimInstance===instanceId||life.active.has(value.row.claim))return;
     const result=receipt(value);if(result!==null)applied(value,result);else{ownership(value);update(value,'unknown');}processed++;
    });}catch{unavailable++;}}
   }
   return {processed,unavailable};
  }); },
  async drain() { closing=true;await Promise.allSettled([...active]); },
 };
 return methods;
}
