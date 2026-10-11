import {randomUUID,randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {FRAME_LIMITS,FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_MUTATION_OPERATIONS,frameSchemas,frameSnapshotSchema,frameTaskResponseSchema,frameRequestResponseSchema,isFrameMutationResponse,canonicalFrameInput as canonical} from '../../contracts/src/frame-extraction.mjs';
import {createFrameOwnershipReader} from './frame-ownership.mjs';
import {createOwnedMediaGraphReader} from './inspection.mjs';
import {createFrameStorage} from './frame-storage.mjs';
import {decodeManagedFrame} from './frame-decoder.mjs';
import {validateManagedSource,verifiedManagedHash,sameManagedFile} from './managed-media.mjs';
import {validatePng} from './images/png.mjs';
import {ownsStoreLock} from './db.mjs';
import {boundedShutdown,assertMediaTerminated} from './operation-lifecycle.mjs';
import {hasUnconfirmedMediaProcesses,terminateMediaProcesses,waitForMediaProcesses} from './media-processes.mjs';

const owners=new WeakMap(),verifiedRefusals=new WeakMap(),noop=()=>{},now=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const equal=(a,b)=>canonical(a)===canonical(b);
const messages=Object.freeze({
 FRAME_NOT_FOUND:'The frame record is unavailable for this project.',FRAME_RECORD_INVALID:'The saved frame record cannot be verified safely.',
 FRAME_REQUEST_CONFLICT:'This request ID was already used for a different frame operation or input.',FRAME_REVISION_CONFLICT:'The frame task changed. Read it again before choosing an action.',
 FRAME_STATE_CONFLICT:'The frame task does not allow this action.',FRAME_CAPACITY:'The retained frame task or request capacity is full.',
 FRAME_QUEUE_FULL:'The local frame queue is full. Try a new request later.',FRAME_OWNER_REQUIRED:'Frame extraction requires the current exclusive workspace owner.',
 FRAME_SERVICE_STOPPED:'The frame service has stopped. Reopen the workspace to inspect the original task.',FRAME_SERVICE_ACTIVE:'This store already owns a different frame service.',
 FRAME_SCHEMA_REQUIRED:'The frame schema is unavailable.',FRAME_SOURCE_INVALID:'The managed source does not meet the local frame profile.',
 FRAME_SOURCE_CHANGED:'The managed source changed after the frame request was prepared.',FRAME_RESULT_INVALID:'The complete local frame result cannot be verified. No new decode was started.',
 FRAME_STORAGE_FAILED:'The local frame result could not be saved.',FRAME_INTERRUPTED:'The local frame task was interrupted. No automatic retry will occur.',
 FRAME_PROFILE_UNSUPPORTED:'The source does not match the supported local frame profile.',FRAME_NO_FRAME:'No supported decoded frame exists at or after the requested mark.',
 FRAME_OUTPUT_INVALID:'The local decoder did not return a valid frame.',FRAME_ATTEMPT_TIMEOUT:'Local frame capture exceeded its time limit.',
 MEDIA_TERMINATION_UNCONFIRMED:'An owned media process has not confirmed its close.',
});
const failure=(code,status=409)=>new AppError(code,messages[code]??messages.FRAME_STORAGE_FAILED,status);
const fail=(code,status)=>{throw failure(code,status);},missing=()=>fail('FRAME_NOT_FOUND',404),invalid=()=>fail('FRAME_RECORD_INVALID');
export function safeFrameServiceError(cause){const code=Object.hasOwn(messages,cause?.code)?cause.code:'FRAME_STORAGE_FAILED',proof=cause&&typeof cause==='object'?verifiedRefusals.get(cause):null;return {code,message:messages[code],status:Number.isInteger(cause?.status)&&cause.status>=400&&cause.status<=599?cause.status:503,...(proof?{details:{frameOutcome:proof}}:{})};}
const bounded=(name,size,nullable=false)=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
const requestColumns=[bounded('requestId',800),bounded('operation',80),bounded('projectId',36),bounded('taskId',36),bounded('inputHash',64),bounded('canonicalInput',FRAME_LIMITS.inputBytes),bounded('response',FRAME_LIMITS.responseBytes)].join(',');
const readErrors=Object.freeze({VALIDATION_ERROR:['Invalid frame operation input.',400],INVALID_CURSOR:['Invalid or expired frame cursor.',400],INSPECTION_UNAVAILABLE:['Frame ownership data is unavailable.',404],INSPECTION_BUDGET_EXCEEDED:['Frame ownership inspection exceeded its safe budget.',429]});
function publicFailure(cause){
 const read=Object.hasOwn(readErrors,cause?.code)?readErrors[cause.code]:null;if(read)return new AppError(cause.code,read[0],read[1]);
 const safe=safeFrameServiceError(cause),error=new AppError(safe.code,safe.message,safe.status,safe.details??{});
 if(safe.details)verifiedRefusals.set(error,safe.details.frameOutcome);return error;
}
const maxRevision=value=>{if(!Number.isSafeInteger(value)||value>=Number.MAX_SAFE_INTEGER)fail('FRAME_CAPACITY',507);};
const stageTask=value=>({...value.row,snapshot:value.snapshot});

/** Local-only, single-owner extraction. The immutable ACK is committed before
 * any work is queued. Startup and historical replay never enter the work queue.
 * This module has no provider, model, settings, network, or generic tool seam. */
export function createFrameServices(store,{signal:ownerSignal,decode=decodeManagedFrame,autoRun=true,fault=noop}={}){
 const old=owners.get(store.db);
 if(old){if(old.root!==store.root||old.signal!==ownerSignal||old.decode!==decode||old.autoRun!==autoRun||old.fault!==fault)fail('FRAME_SERVICE_ACTIVE');return old.service;}
 const {db,root,tx}=store,queue=[],pending=new Set(),preparations=new Map(),active=new Set(),attemptSignals=new Set(),secret=randomBytes(32);
 const controller=new AbortController(),signal=ownerSignal?AbortSignal.any([ownerSignal,controller.signal]):controller.signal;
 let stopped=false,running=false,reported=false,draining;
 const registration={root,signal:ownerSignal,decode,autoRun,fault};
 const storage=createFrameStorage(store,{validatePng});
 function schemaPresent(){
  const n=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('frame_tasks','frame_requests')").get().n;
  if(n===2)return true;if(n||db.prepare('SELECT 1 FROM schema_version WHERE version=20').get())invalid();return false;
 }
 function owner({allowStopped=false}={}){
  if(owners.get(db)!==registration||!ownsStoreLock(store))fail('FRAME_OWNER_REQUIRED',403);
  if(!allowStopped&&(stopped||signal.aborted))fail('FRAME_SERVICE_STOPPED',503);
 }
 function project(projectId){
  const row=db.prepare(`SELECT ${bounded('data',16384)} FROM projects WHERE id=? LIMIT 1`).get(projectId);let value;
  try{value=JSON.parse(row?.data);}catch{missing();}if(!value||typeof value!=='object'||Array.isArray(value)||value.id!==projectId)missing();return value;
 }
 function task(projectId,id,{graph=true}={}){
  project(projectId);if(!db.prepare('SELECT 1 FROM frame_tasks WHERE id=? AND projectId=? LIMIT 1').get(id,projectId))missing();
  if(graph)return createOwnedMediaGraphReader(db,projectId).frameTask(id);
  return createFrameOwnershipReader(db,projectId,{fail:invalid}).task(id);
 }
 function taskDto(projectId,id){return task(projectId,id).dto;}
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
 function prior(operation,input){
  const row=db.prepare(`SELECT ${requestColumns} FROM frame_requests WHERE requestId=? LIMIT 1`).get(input.requestId);if(!row)return null;
  if(row.projectId!==input.projectId||row.operation!==operation||row.inputHash!==hash(input)||row.canonicalInput!==canonical(input))fail('FRAME_REQUEST_CONFLICT');
  let response;try{response=JSON.parse(row.response);}catch{invalid();}
  if(!isFrameMutationResponse(operation,input,response)||response.id!==row.taskId)invalid();
  const saved=task(input.projectId,row.taskId);
  if(saved.row.revision<response.revision||saved.row.requestId!==response.requestId||saved.input.sourceAssetId!==response.sourceAssetId||saved.input.sourceHash!==response.sourceHash||saved.input.sourceFrame!==response.sourceFrame||saved.row.createdAt!==response.createdAt)invalid();
  return response;
 }
 function requestGet(input){
  project(input.projectId);const row=db.prepare(`SELECT ${requestColumns} FROM frame_requests WHERE requestId=? AND projectId=? LIMIT 1`).get(input.requestId,input.projectId);if(!row)return null;
  let original;try{original=JSON.parse(row.canonicalInput);}catch{invalid();}
  if(!frameSchemas[row.operation]?.safeParse(original).success||original.projectId!==input.projectId||original.requestId!==input.requestId)invalid();
  const response=prior(row.operation,original),value={projectId:input.projectId,requestId:input.requestId,operation:row.operation,response};if(!frameRequestResponseSchema.safeParse(value).success)invalid();return value;
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
 const sign=value=>createHmac('sha256',secret).update(value).digest('base64url');
 function page(input){
  project(input.projectId);const limit=input.limit??FRAME_LIMITS.pageSize,scope=['frame.task.list',input.projectId,limit,'createdAt-desc,id-desc'];let after=null;
  if(input.cursor)try{
   const [body,mac,...rest]=input.cursor.split('.');if(rest.length||!mac||mac.length!==43||!timingSafeEqual(Buffer.from(mac),Buffer.from(sign(body))))throw Error();
   const decoded=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));if(!Array.isArray(decoded)||decoded.length!==5||!equal(decoded.slice(0,4),scope))throw Error();
   after=decoded[4];if(!Array.isArray(after)||after.length!==2||typeof after[0]!=='string'||after[0].length>40||!Number.isFinite(Date.parse(after[0]))||!frameSchemas['frame.task.get'].shape.taskId.safeParse(after[1]).success)throw Error();
  }catch{throw new AppError('INVALID_CURSOR','Invalid or expired frame cursor.',400);}
  const rows=db.prepare(`SELECT ${bounded('id',36)},${bounded('createdAt',40)} FROM frame_tasks WHERE projectId=?${after?' AND (createdAt<? OR (createdAt=? AND id<?))':''} ORDER BY createdAt DESC,id DESC LIMIT ?`)
   .all(input.projectId,...(after?[after[0],after[0],after[1]]:[]),limit+1),selected=rows.slice(0,limit),graph=createOwnedMediaGraphReader(db,input.projectId),items=selected.map(row=>graph.frameTask(row.id).dto);
  let nextCursor=null;if(rows.length>limit){const last=selected.at(-1),body=Buffer.from(JSON.stringify([...scope,[last.createdAt,last.id]])).toString('base64url');nextCursor=`${body}.${sign(body)}`;}
  return {projectId:input.projectId,items,nextCursor};
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
 const snapshotRead=read=>input=>{const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');try{return read(input);}finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}};
 const handlers={'frame.extract':extract,'frame.request.get':snapshotRead(requestGet),'frame.task.get':snapshotRead(input=>taskDto(input.projectId,input.taskId)),
  'frame.task.list':snapshotRead(page),'frame.task.cancelQueued':cancel,'frame.task.recoverResult':recover};
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
 const service={handlers,drain};registration.service=service;owners.set(db,registration);
 try{reconcile();}catch(cause){owners.delete(db);throw cause;}return service;
}
