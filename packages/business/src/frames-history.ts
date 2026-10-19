import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {FRAME_LIMITS,frameSchemas,frameRequestResponseSchema,isFrameMutationResponse,canonicalFrameInput as canonical} from '../../contracts/src/frame-extraction.ts';
import {createFrameOwnershipReader} from './frame-ownership.ts';
import {createOwnedMediaGraphReader} from './inspection.ts';

const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const equal=(a,b)=>canonical(a)===canonical(b);
export const frameServiceMessages=Object.freeze({
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
export const frameServiceFailure=(code,status=409)=>new AppError(code,frameServiceMessages[code]??frameServiceMessages.FRAME_STORAGE_FAILED,status);
const fail=(code,status)=>{throw frameServiceFailure(code,status);},missing=()=>fail('FRAME_NOT_FOUND',404),invalid=()=>fail('FRAME_RECORD_INVALID');
const bounded=(name,size,nullable=false)=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
const requestColumns=[bounded('requestId',800),bounded('operation',80),bounded('projectId',36),bounded('taskId',36),bounded('inputHash',64),bounded('canonicalInput',FRAME_LIMITS.inputBytes),bounded('response',FRAME_LIMITS.responseBytes)].join(',');
const readErrors=Object.freeze({VALIDATION_ERROR:['Invalid frame operation input.',400],INVALID_CURSOR:['Invalid or expired frame cursor.',400],INSPECTION_UNAVAILABLE:['Frame ownership data is unavailable.',404],INSPECTION_BUDGET_EXCEEDED:['Frame ownership inspection exceeded its safe budget.',429]});
export function safeFrameFailure(cause){const code=Object.hasOwn(frameServiceMessages,cause?.code)?cause.code:'FRAME_STORAGE_FAILED';return {code,message:frameServiceMessages[code],status:Number.isInteger(cause?.status)&&cause.status>=400&&cause.status<=599?cause.status:503};}
export function framePublicFailure(cause,details={}){
 const read=Object.hasOwn(readErrors,cause?.code)?readErrors[cause.code]:null;if(read)return new AppError(cause.code,read[0],read[1]);
 const safe=safeFrameFailure(cause);return new AppError(safe.code,safe.message,safe.status,details);
}

/** Saved metadata only. No decoder/storage constructor, file I/O, startup
 * reconciliation or task queue is reachable. Original ACK disclosure carries
 * no recovery authority. The normal lifecycle reuses these same readers. */
export function createFrameHistoryReaders({db}){
 const secret=randomBytes(32);
 function schemaPresent(){
  const n=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('frame_tasks','frame_requests')").get().n;
  if(n===2)return true;if(n||db.prepare('SELECT 1 FROM schema_version WHERE version=20').get())invalid();return false;
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
 const snapshotRead=read=>input=>{const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');try{return read(input);}finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}};
 const reads={'frame.request.get':snapshotRead(requestGet),'frame.task.get':snapshotRead(input=>taskDto(input.projectId,input.taskId)),'frame.task.list':snapshotRead(page)};
 const handlers=Object.freeze(Object.fromEntries(Object.entries(reads).map(([operation,read])=>[operation,input=>{
  try{
   if(!schemaPresent())fail('FRAME_SCHEMA_REQUIRED',503);const parsed=frameSchemas[operation].safeParse(input);if(!parsed.success)throw new AppError('VALIDATION_ERROR','Invalid frame operation input.',400);
   return read(parsed.data);
  }catch(cause){throw framePublicFailure(cause);}
 }])));
 return Object.freeze({handlers,schemaPresent,project,task,taskDto,prior});
}
