import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {workspaceRestoreError} from './workspace-restore-policy.ts';
import {randomUUID,createHash} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {FRAME_LIMITS,FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_MUTATION_OPERATIONS,frameSchemas,frameSnapshotSchema,frameTaskResponseSchema,isFrameMutationResponse,canonicalFrameInput as canonical} from '../../contracts/src/frame-extraction.ts';
import {createFrameHistoryReaders,frameServiceMessages as messages,frameServiceFailure as failure,safeFrameFailure,framePublicFailure} from './frames-history.ts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {createFrameStorage} from './frame-storage.ts';
import {decodeManagedFrame} from './frame-decoder.ts';
import {validateManagedSource,verifiedManagedHash,sameManagedFile} from './managed-media.ts';
import {validatePng} from './images/png.ts';
import {ownsStoreLock} from './db.ts';
import {boundedShutdown,assertMediaTerminated} from './operation-lifecycle.ts';
import {hasUnconfirmedMediaProcesses,terminateMediaProcesses,waitForMediaProcesses} from './media-processes.ts';

const owners=new WeakMap(),verifiedRefusals=new WeakMap(),noop=()=>{},now=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const equal=(a,b)=>canonical(a)===canonical(b);
const fail=(code,status)=>{throw failure(code,status);},missing=()=>fail('FRAME_NOT_FOUND',404),invalid=()=>fail('FRAME_RECORD_INVALID');
export function safeFrameServiceError(cause){const safe=safeFrameFailure(cause),proof=cause&&typeof cause==='object'?verifiedRefusals.get(cause):null;return {...safe,...(proof?{details:{frameOutcome:proof}}:{})};}
const bounded=(name,size,nullable=false)=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
function publicFailure(cause){
 const safe=safeFrameServiceError(cause),error=framePublicFailure(cause,safe.details??{});
 if(safe.details)verifiedRefusals.set(error,safe.details.frameOutcome);return error;
}
const maxRevision=value=>{if(!Number.isSafeInteger(value)||value>=Number.MAX_SAFE_INTEGER)fail('FRAME_CAPACITY',507);};
const stageTask=value=>({...value.row,snapshot:value.snapshot});

/** Local-only, single-owner extraction. The immutable ACK is committed before
 * any work is queued. Startup and historical replay never enter the work queue.
 * This module has no provider, model, settings, network, or generic tool seam. */
export function createFrameServices(store,{signal:ownerSignal,decode=decodeManagedFrame,autoRun=true,fault=noop}={}){
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const old=owners.get(store.db);
 if(old){if(old.root!==store.root||old.signal!==ownerSignal||old.decode!==decode||old.autoRun!==autoRun||old.fault!==fault)fail('FRAME_SERVICE_ACTIVE');return old.service;}
 const {db,root,tx}=store,queue=[],pending=new Set(),preparations=new Map(),active=new Set(),attemptSignals=new Set();
 const controller=new AbortController(),signal=ownerSignal?AbortSignal.any([ownerSignal,controller.signal]):controller.signal;
 let stopped=false,running=false,reported=false,draining;
 const registration={root,signal:ownerSignal,decode,autoRun,fault};
 const storage=createFrameStorage(store,{validatePng});
 const history=createFrameHistoryReaders(store),{schemaPresent,project,task,prior}=history;
 function owner({allowStopped=false}={}){
  if(owners.get(db)!==registration||!ownsStoreLock(store))fail('FRAME_OWNER_REQUIRED',403);
  if(!allowStopped&&(stopped||signal.aborted))fail('FRAME_SERVICE_STOPPED',503);
 }
 function current(original,{allowStopped=false}={}){
  owner({allowStopped});const value=task(original.row.projectId,original.row.id);
  for(const key of ['revision','state','inputHash','input','snapshot','started','stagedReceipt','assetId'])if(value.row[key]!==original.row[key])fail('FRAME_REVISION_CONFLICT');
  return value;
 }
 function change(original,patch,{allowStopped=false}={}){
  const value=current(original,{allowStopped});maxRevision(value.row.revision);
  if(Object.keys(patch).some(key=>!['state','started','stagedReceipt','assetId','errorCode'].includes(key)))throw Error('Invalid internal frame patch');
  const entries=Object.entries(patch),result=db.prepare(`UPDATE frame_tasks SET ${entries.map(([key])=>`${key}=?`).join(',')},revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?`)
   .run(...entries.map(([,value])=>value),now(),value.row.id,value.row.projectId,value.row.revision);
  if(result.changes!==1)fail('FRAME_REVISION_CONFLICT');return task(value.row.projectId,value.row.id);
 }
 const count=(table,where,args,cap)=>db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table}${where?' WHERE '+where:''} LIMIT ?)`).get(...args,cap+1).n;
 function capacity(projectId,{extract=false,taskId,recover=false}={}){
  if(count('frame_requests','',[],FRAME_LIMITS.requestsGlobal)>=FRAME_LIMITS.requestsGlobal||count('frame_requests','projectId=?',[projectId],FRAME_LIMITS.requestsPerProject)>=FRAME_LIMITS.requestsPerProject||
   taskId&&count('frame_requests','taskId=?',[taskId],FRAME_LIMITS.requestsPerTask)>=FRAME_LIMITS.requestsPerTask)fail('FRAME_CAPACITY',507);
  if(recover&&(running||db.prepare("SELECT 1 FROM frame_tasks WHERE state IN ('running','persisting') LIMIT 1").get()))fail('FRAME_QUEUE_FULL');
  if(!extract)return;
  if(count('frame_tasks','',[],FRAME_LIMITS.tasksGlobal)>=FRAME_LIMITS.tasksGlobal||count('frame_tasks','projectId=?',[projectId],FRAME_LIMITS.tasksPerProject)>=FRAME_LIMITS.tasksPerProject)fail('FRAME_CAPACITY',507);
  if(count('frame_tasks',"state='queued'",[],FRAME_LIMITS.queuedGlobal)>=FRAME_LIMITS.queuedGlobal||count('frame_tasks',"state='queued' AND projectId=?",[projectId],FRAME_LIMITS.queuedPerProject)>=FRAME_LIMITS.queuedPerProject)fail('FRAME_QUEUE_FULL');
 }
 function source(input,snapshot){
  project(input.projectId);if(!db.prepare('SELECT 1 FROM assets WHERE id=? AND projectId=? LIMIT 1').get(input.sourceAssetId,input.projectId))missing();
  const asset=createOwnedMediaGraphReader(db,input.projectId).asset(input.sourceAssetId);
  if(asset.sha256!==input.sourceHash)fail('FRAME_SOURCE_CHANGED');
  const frozen={assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,sizeBytes:asset.sizeBytes,relativePath:asset.relativePath,duration:asset.duration,width:asset.width,height:asset.height};
  if(snapshot&&!equal(frozen,snapshot.source))fail('FRAME_SOURCE_CHANGED');
  return {asset,frozen};
 }
 function sourceFile(asset){try{const result=validateManagedSource(root,asset,{maxBytes:FRAME_LIMITS.sourceBytes});if(result.info.size!==asset.sizeBytes)fail('FRAME_SOURCE_CHANGED');return result;}catch(cause){if(cause.code==='FRAME_SOURCE_CHANGED')throw cause;fail('FRAME_SOURCE_INVALID');}}
 async function sourceHash(asset,expected){try{return await verifiedManagedHash(root,asset,{signal,expected,maxBytes:FRAME_LIMITS.sourceBytes});}catch(cause){if(signal.aborted)fail('FRAME_SERVICE_STOPPED',503);fail(cause.code==='MANAGED_SOURCE_CHANGED'?'FRAME_SOURCE_CHANGED':'FRAME_SOURCE_INVALID');}}
 function sourceFence(original,expected){
  const value=current(original),{asset}=source(value.input,value.snapshot),file=sourceFile(asset);
  if(expected&&!sameManagedFile(file.info,expected))fail('FRAME_SOURCE_CHANGED');return {...file,asset,value};
 }
 function record(operation,input,response){
  if(!isFrameMutationResponse(operation,input,response))invalid();fault('before_request_receipt',{operation,input});
  db.prepare('INSERT INTO frame_requests(requestId,operation,projectId,taskId,inputHash,canonicalInput,response) VALUES(?,?,?,?,?,?,?)')
   .run(input.requestId,operation,input.projectId,response.id,hash(input),canonical(input),canonical(response));
 }
 function accepted(operation,input,value){
  if(operation==='frame.task.cancelQueued'){
   const index=queue.findIndex(entry=>entry.id===value.id);if(index!==-1)queue.splice(index,1);pending.delete(value.id);
  }
  fault('after_acceptance',{operation,input,response:value});if(operation!=='frame.task.cancelQueued')enqueue(value.id,input.projectId,operation==='frame.task.recoverResult');return value;
 }
 async function extract(input){
  owner();project(input.projectId);const replay=prior('frame.extract',input);if(replay)return replay;
  capacity(input.projectId,{extract:true});const {asset,frozen}=source(input),id=randomUUID(),snapshot={schemaVersion:1,projectId:input.projectId,taskId:id,source:frozen,requested:{sourceFrame:input.sourceFrame,fps:30},profile:FRAME_PROFILE};
  if(!frameSnapshotSchema.safeParse(snapshot).success)fail('FRAME_SOURCE_INVALID');
  const file=sourceFile(asset),verified=await sourceHash(asset,file.info);owner();
  const result=tx(()=>{
   owner();project(input.projectId);const previous=prior('frame.extract',input);if(previous)return {value:previous,replayed:true};
   capacity(input.projectId,{extract:true});const latest=source(input,snapshot),checked=sourceFile(latest.asset);if(!sameManagedFile(verified.info,checked.info))fail('FRAME_SOURCE_CHANGED');
   const timestamp=now(),value={id,projectId:input.projectId,requestId:input.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,sourceFrame:input.sourceFrame,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp};
   if(!frameTaskResponseSchema.safeParse(value).success)invalid();
   db.prepare("INSERT INTO frame_tasks(id,projectId,requestId,inputHash,input,snapshot,state,revision,started,stagedReceipt,assetId,errorCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,?,?)")
    .run(id,input.projectId,input.requestId,hash(input),canonical(input),canonical(snapshot),timestamp,timestamp);
   record('frame.extract',input,value);task(input.projectId,id);return {value,replayed:false};
  });
  return result.replayed?result.value:accepted('frame.extract',input,result.value);
 }
 function cancel(input){
  const result=tx(()=>{
   owner();project(input.projectId);const replay=prior('frame.task.cancelQueued',input);if(replay)return {value:replay,replayed:true};
   const target=task(input.projectId,input.taskId);if(target.row.revision!==input.expectedRevision)fail('FRAME_REVISION_CONFLICT');
   if(!['queued','interrupted'].includes(target.row.state)||target.row.started||target.receipt)fail('FRAME_STATE_CONFLICT');capacity(input.projectId,{taskId:target.row.id});
   const value=change(target,{state:'cancelled_before_start',errorCode:null}).dto;record('frame.task.cancelQueued',input,value);return {value,replayed:false};
  });return result.replayed?result.value:accepted('frame.task.cancelQueued',input,result.value);
 }
 async function recover(input){
  owner();project(input.projectId);const replay=prior('frame.task.recoverResult',input);if(replay)return replay;
  const target=task(input.projectId,input.taskId);if(target.row.revision!==input.expectedRevision)fail('FRAME_REVISION_CONFLICT');
  if(!['interrupted','local_result_error'].includes(target.row.state)||!target.row.started)fail('FRAME_STATE_CONFLICT');capacity(input.projectId,{taskId:target.row.id,recover:true});
  const before=sourceFence(target),verified=await sourceHash(before.asset,before.info);sourceFence(target,verified.info);
  let receipt;try{receipt=storage.readReceipt(stageTask(target));if(!receipt)fail('FRAME_RESULT_INVALID');await storage.verify(stageTask(target),receipt,()=>sourceFence(target,verified.info),{signal});}
  catch(cause){if(['FRAME_OWNER_REQUIRED','FRAME_SERVICE_STOPPED','FRAME_REVISION_CONFLICT','FRAME_SOURCE_CHANGED'].includes(cause.code))throw cause;fail('FRAME_RESULT_INVALID');}
  const result=tx(()=>{
   owner();project(input.projectId);const previous=prior('frame.task.recoverResult',input);if(previous)return {value:previous,replayed:true};
   sourceFence(target,verified.info);capacity(input.projectId,{taskId:target.row.id,recover:true});
   // Re-observe immutable manifest identity after asynchronous PNG validation.
   const latest=storage.readReceipt(stageTask(target));if(!latest||!equal(latest,receipt))fail('FRAME_RESULT_INVALID');
   const value=change(target,{state:'persisting',stagedReceipt:target.row.stagedReceipt??canonical(receipt),errorCode:null}).dto;
   record('frame.task.recoverResult',input,value);return {value,replayed:false};
  });return result.replayed?result.value:accepted('frame.task.recoverResult',input,result.value);
 }
 function diagnose(){if(!reported){reported=true;console.error('Skipped invalid local frame record.');}}
 async function finalize(original,expected){
  let checked=sourceFence(original,expected);const verified=await sourceHash(checked.asset,checked.info);checked=sourceFence(original,verified.info);
  const receipt=checked.value.receipt;if(!receipt)fail('FRAME_RESULT_INVALID');
  const check=()=>{sourceFence(original,verified.info);if(db.prepare('SELECT 1 FROM assets WHERE id=? LIMIT 1').get(receipt.assetId))fail('FRAME_RESULT_INVALID');};
  const file=await storage.publish(stageTask(original),receipt,check,{signal});check();fault('after_media_publication',{taskId:original.row.id});
  const result=tx(()=>{
   check();const timestamp=now(),asset={id:receipt.assetId,projectId:original.row.projectId,name:`Frame ${original.input.sourceFrame}.png`,mimeType:'image/png',sha256:receipt.sha256,width:receipt.width,height:receipt.height,sizeBytes:receipt.byteLength,relativePath:file.relativePath,url:`/media/${receipt.assetId}`,provenance:'extracted-frame',createdAt:timestamp};
   db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(asset.id,asset.projectId,JSON.stringify(asset));
   const completed=change(original,{state:'succeeded',assetId:asset.id,errorCode:null});createOwnedMediaGraphReader(db,asset.projectId).asset(asset.id);fault('before_result_commit',{taskId:original.row.id});return completed;
  });
  try{storage.discardStagedPng(stageTask(result),()=>current(result));}catch{/* Retaining a private stage cannot undo a committed result. */}
 }
 async function execute(entry){
  let original,registeredSignal;
  try{
   owner();original=task(entry.projectId,entry.id);
   if(entry.local){if(original.row.state!=='persisting')return;await finalize(original);return;}
   if(original.row.state!=='queued')return;
   const before=sourceFence(original),verified=await sourceHash(before.asset,before.info);sourceFence(original,verified.info);
   const beforeSpawn=attemptSignal=>{
    if(!attemptSignal||typeof attemptSignal.addEventListener!=='function'||attemptSignal.aborted)fail('FRAME_INTERRUPTED');
    if(registeredSignal&&registeredSignal!==attemptSignal)fail('FRAME_RECORD_INVALID');registeredSignal=attemptSignal;attemptSignals.add(attemptSignal);
    original=tx(()=>{
     const value=sourceFence(original,verified.info).value;
     if(value.row.state==='queued')return change(value,{state:'running',started:1,errorCode:null});
     if(value.row.state!=='running'||!value.row.started)fail('FRAME_STATE_CONFLICT');return value;
    });fault('after_start_fence',{taskId:original.row.id});
   };
   const result=await decode({root,asset:before.asset,file:verified.file,info:verified.info,requestedFrame:original.input.sourceFrame,signal,beforeSpawn});
   sourceFence(original,verified.info);if(original.row.state!=='running'||!original.row.started||!registeredSignal)invalid();
   const receipt=await storage.stage(stageTask(original),result,()=>sourceFence(original,verified.info),{signal});fault('after_result_manifest',{taskId:original.row.id});
   original=tx(()=>{sourceFence(original,verified.info);return change(original,{state:'persisting',stagedReceipt:canonical(receipt),errorCode:null});});fault('after_result_receipt',{taskId:original.row.id});
   await finalize(original,verified.info);
  }catch(cause){
   if(original)try{
    const checked=current(original,{allowStopped:true});if(!['queued','running','persisting'].includes(checked.row.state))return;
    let receipt=checked.receipt;try{receipt??=storage.readReceipt(stageTask(checked));}catch{}
    tx(()=>{
     if(receipt&&checked.row.started)change(checked,{state:'local_result_error',stagedReceipt:checked.row.stagedReceipt??canonical(receipt),errorCode:'FRAME_RESULT_INVALID'},{allowStopped:true});
     else if(stopped||signal.aborted||cause.terminationUnconfirmed||['MEDIA_CANCELLED','FRAME_INTERRUPTED','FRAME_SERVICE_STOPPED'].includes(cause.code))change(checked,{state:'interrupted',errorCode:'FRAME_INTERRUPTED'},{allowStopped:true});
     else change(checked,{state:'failed',errorCode:Object.hasOwn(messages,cause.code)?cause.code:cause.code==='MANAGED_SOURCE_CHANGED'?'FRAME_SOURCE_CHANGED':'FRAME_STORAGE_FAILED'},{allowStopped:true});
    });
   }catch{diagnose();}
  }finally{
   // A decoder error is not evidence of child close. This exact registered
   // attempt owns the resource slot until every owned handle emits close.
   if(registeredSignal){await waitForMediaProcesses({signal:registeredSignal});attemptSignals.delete(registeredSignal);}
  }
 }
 function enqueue(id,projectId,local){
  if(!autoRun||stopped||signal.aborted||pending.has(id))return;
  const target=task(projectId,id);if(target.row.state!==(local?'persisting':'queued'))return;
  if(queue.length>=FRAME_LIMITS.queuedGlobal+FRAME_LIMITS.activeGlobal)fail('FRAME_QUEUE_FULL');
  pending.add(id);if(local)queue.unshift({id,projectId,local});else queue.push({id,projectId,local});queueMicrotask(pump);
 }
 function pump(){
  if(running||stopped||signal.aborted)return;const entry=queue[0];if(!entry)return;
  // A durable active row whose enqueue was lost must remain visible for
  // restart reconciliation; it cannot cause unrelated queued tasks to fail.
  try{owner();if(!entry.local&&db.prepare("SELECT 1 FROM frame_tasks WHERE state IN ('running','persisting') LIMIT 1").get())return;}catch{diagnose();return;}
  queue.shift();running=true;
  const promise=execute(entry).finally(()=>{active.delete(promise);pending.delete(entry.id);running=false;pump();});active.add(promise);void promise.catch(diagnose);
 }
 function reconcile(){
  if(!ownsStoreLock(store)||!schemaPresent())return;
  const rows=db.prepare(`SELECT ${bounded('id',36)},${bounded('projectId',36)} FROM frame_tasks WHERE state IN ('queued','running','persisting') ORDER BY id LIMIT ?`).all(FRAME_LIMITS.queuedGlobal+FRAME_LIMITS.activeGlobal+1);
  if(rows.length>FRAME_LIMITS.queuedGlobal+FRAME_LIMITS.activeGlobal){diagnose();return;}
  for(const row of rows)try{const target=task(row.projectId,row.id);tx(()=>change(target,{state:'interrupted',errorCode:'FRAME_INTERRUPTED'}));}catch{diagnose();}
 }
 const refusalCodes=new Set(['FRAME_CAPACITY','FRAME_QUEUE_FULL','FRAME_REVISION_CONFLICT','FRAME_STATE_CONFLICT','FRAME_SOURCE_INVALID','FRAME_SOURCE_CHANGED','FRAME_RESULT_INVALID']);
 function proveRefusal(operation,input,cause){
  // An error label alone is never proof of nonacceptance. A fresh exclusive
  // synchronous transaction must establish scope and absence of this exact
  // global request ID after the failed operation's transaction has ended.
  if(!(cause instanceof AppError)||!refusalCodes.has(cause.code)||db.isTransaction)return;
  try{
   const proof=tx(()=>{
    owner();project(input.projectId);
    if(operation==='frame.extract'){
     if(!db.prepare('SELECT 1 FROM assets WHERE id=? AND projectId=? LIMIT 1').get(input.sourceAssetId,input.projectId))missing();
     createOwnedMediaGraphReader(db,input.projectId).asset(input.sourceAssetId);
    }else task(input.projectId,input.taskId);
    if(db.prepare('SELECT 1 FROM frame_requests WHERE requestId=? LIMIT 1').get(input.requestId))return null;
    return {status:'not_accepted',projectId:input.projectId,operation,requestId:input.requestId,inputHash:hash(input)};
   });
   if(proof){cause.details={frameOutcome:proof};verifiedRefusals.set(cause,proof);}
  }catch{/* Unknown scope, owner, storage or commit outcome remains unknown. */}
 }
 function prepareMutation(operation,input,invoke){
  owner();project(input.projectId);const replay=prior(operation,input);if(replay)return replay;
  const exact=canonical(input),existing=preparations.get(input.requestId);
  if(existing){if(existing.operation!==operation||existing.canonicalInput!==exact)fail('FRAME_REQUEST_CONFLICT');return existing.promise;}
  if(preparations.size>=FRAME_LIMITS.queuedGlobal||[...preparations.values()].filter(entry=>entry.projectId===input.projectId).length>=FRAME_LIMITS.queuedPerProject)fail('FRAME_QUEUE_FULL');
  const entry={operation,projectId:input.projectId,canonicalInput:exact};
  entry.promise=Promise.resolve().then(invoke).finally(()=>{if(preparations.get(input.requestId)===entry)preparations.delete(input.requestId);});
  preparations.set(input.requestId,entry);return entry.promise;
 }
 function guardedMutation(operation,input,invoke){
  try{const result=invoke();if(result&&typeof result.then==='function')return result.catch(cause=>{proveRefusal(operation,input,cause);throw cause;});return result;}
  catch(cause){proveRefusal(operation,input,cause);throw cause;}
 }
 const handlers={'frame.extract':extract,'frame.task.cancelQueued':cancel,'frame.task.recoverResult':recover};
 for(const [operation,handler] of Object.entries(handlers))handlers[operation]=input=>{
  try{
   if(!schemaPresent())fail('FRAME_SCHEMA_REQUIRED',503);const parsed=frameSchemas[operation].safeParse(input);if(!parsed.success)throw new AppError('VALIDATION_ERROR','Invalid frame operation input.',400);
   const mutating=FRAME_MUTATION_OPERATIONS.includes(operation);
   if(mutating&&Buffer.byteLength(canonical(parsed.data))>FRAME_LIMITS.inputBytes)fail('FRAME_CAPACITY',507);
   const invoke=()=>operation==='frame.extract'||operation==='frame.task.recoverResult'?prepareMutation(operation,parsed.data,()=>handler(parsed.data)):handler(parsed.data);
   const value=mutating?guardedMutation(operation,parsed.data,invoke):handler(parsed.data);
   return value&&typeof value.then==='function'?value.catch(cause=>{throw publicFailure(cause);}):value;
  }catch(cause){throw publicFailure(cause);}
 };
 function drain(){
  if(draining)return draining;stopped=true;controller.abort();queue.length=0;
  const result=boundedShutdown((async()=>{
   const results=await Promise.all([...attemptSignals].map(attemptSignal=>terminateMediaProcesses({signal:attemptSignal})));assertMediaTerminated(results.flat());
   await Promise.allSettled([...active,...[...preparations.values()].map(entry=>entry.promise)]);if([...attemptSignals].some(attemptSignal=>hasUnconfirmedMediaProcesses({signal:attemptSignal})))assertMediaTerminated([{status:'unconfirmed'}]);
  })(),'FRAME_STOP_TIMEOUT');draining=result;void result.catch(()=>{if(draining===result)draining=undefined;});return result;
 }
 Object.assign(handlers,history.handlers);
 const service={handlers,drain};registration.service=service;owners.set(db,registration);
 try{reconcile();}catch(cause){owners.delete(db);throw cause;}return service;
}
