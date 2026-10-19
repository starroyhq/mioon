import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {AppError,parse,IMAGE_LIMITS,imageSchemas,isImageMutationResponse,imageRequestResponseSchema} from '@mioon/contracts';
import {createImageOwnershipReader} from '../image-ownership.ts';
import {createOwnedMediaGraphReader} from '../inspection.ts';
import {imageEditFields} from './edit-source.ts';
import {validateImageTaskReview} from './reviews.ts';

const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const equal=(a,b)=>canonical(a)===canonical(b);
export const imageServiceMessages=Object.freeze({IMAGE_SOURCE_INVALID:'此项目的原始 PNG 无法安全核验；不会发送或重新生成。',IMAGE_NOT_FOUND:'找不到此项目的图像记录。',IMAGE_RECORD_INVALID:'图像记录无法安全核验，请保留原任务并检查本地数据。',IMAGE_LIVE_DISABLED:'OpenAI 图像调用尚未启用；请先配置独立图像设置。',IMAGE_REVIEW_REQUIRED:'当前付费图像请求需要用户明确确认；请先准备并查看原请求。',IMAGE_REQUEST_CONFLICT:'此图像请求 ID 已用于不同的操作、项目或内容。',IMAGE_REVISION_CONFLICT:'图像组或任务已有新状态，请重新读取后明确操作。',IMAGE_GROUP_BUSY:'此图像组仍有待处理或结果待确认的任务，请先查看原任务。',IMAGE_STATE_CONFLICT:'当前图像任务状态不允许此操作。',IMAGE_CAPACITY:'图像任务或回执保留容量已满，无法安全接受新操作；这不表示磁盘已满。',IMAGE_QUEUE_FULL:'本地图像队列已满，请稍后再明确提交。',IMAGE_OWNER_REQUIRED:'此操作需要当前工作区的独占后端，请连接运行中的后端。',IMAGE_SERVICE_STOPPED:'图像服务已停止，请重新打开后查看原任务。',IMAGE_RESULT_INVALID:'本地图像结果无法完整核验；不会重新调用供应商。',IMAGE_STORAGE_FAILED:'无法保存图像结果，请查看原任务；不会重新生成。'});
export const imageServiceError=(code,status=409)=>new AppError(code,imageServiceMessages[code]||'图像操作未完成，请查看原任务。',status);
const fail=(code,status)=>{throw imageServiceError(code,status);};
const missing=()=>fail('IMAGE_NOT_FOUND',404),invalid=()=>fail('IMAGE_RECORD_INVALID');
const bounded=(name,size,nullable=false)=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
const requestColumns=[bounded('requestId',800),bounded('operation',80),bounded('projectId',36),bounded('inputHash',64),bounded('canonicalInput',IMAGE_LIMITS.inputBytes),bounded('response',IMAGE_LIMITS.responseBytes)].join(',');

/** Saved metadata only. This factory does not construct a lifecycle, read files,
 * inspect settings/providers, reconcile records or grant execution authority.
 * The normal lifecycle reuses these exact readers and original receipt checks.
 * Internal readers below are also pure; only handlers are transport-facing. */
export function createImageHistoryReaders({db}) {
 const secret=randomBytes(32);
 const reviewBinding=value=>validateImageTaskReview(db,value.row.projectId,value.row.id,value.input);
 const schemaPresent=()=>{
  const present=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('image_groups','image_tasks','image_versions','image_requests')").get().n;
  if(present===4)return true;
  if(present||db.prepare('SELECT 1 FROM schema_version WHERE version=16').get())invalid();
  return false;
 };
 function project(projectId){
  const row=db.prepare(`SELECT id,${bounded('data',16384)} FROM projects WHERE id=? LIMIT 1`).get(projectId);
  let value;try{value=JSON.parse(row?.data);}catch{missing();}if(value?.id!==projectId)missing();return value;
 }
 const reader=projectId=>createImageOwnershipReader(db,projectId,{fail:invalid});
 function task(projectId,id,{shallow=false}={}){project(projectId);const row=db.prepare('SELECT id FROM image_tasks WHERE id=? AND projectId=?').get(id,projectId);if(!row)missing();return reader(projectId).task(id,{shallow});}
 function group(projectId,id){
  project(projectId);if(!db.prepare('SELECT id FROM image_groups WHERE id=? AND projectId=?').get(id,projectId))missing();
  const read=reader(projectId),value=read.group(id);if(value.headVersionId)createOwnedMediaGraphReader(db,projectId).imageVersion(value.headVersionId);if(value.activeTaskId){const active=read.task(value.activeTaskId);reviewBinding(active);}return value;
 }
 function taskDto(projectId,id){const value=task(projectId,id);reviewBinding(value);if(value.dto.versionId)createOwnedMediaGraphReader(db,projectId).imageVersion(value.dto.versionId);return value.dto;}
 // Disclosure of an original ACK is not approval, recovery or scheduling.
 function prior(operation,input){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_remote_observations'").get()&&db.prepare('SELECT 1 FROM image_remote_observations WHERE requestId=?').get(input.requestId))fail('IMAGE_REQUEST_CONFLICT');
  const row=db.prepare(`SELECT ${requestColumns} FROM image_requests WHERE requestId=?`).get(input.requestId);if(!row)return null;
  if(row.projectId!==input.projectId||row.operation!==operation||row.inputHash!==hash(input)||row.canonicalInput!==canonical(input))fail('IMAGE_REQUEST_CONFLICT');
  let response;try{response=JSON.parse(row.response);}catch{invalid();}
  if(!isImageMutationResponse(operation,input,response))invalid();
  const currentTask=task(input.projectId,response.id,{shallow:operation==='image.task.cancelQueued'});reviewBinding(currentTask);
  if(currentTask.row.requestId!==response.requestId||currentTask.row.groupId!==response.groupId||currentTask.row.revision<response.revision||currentTask.snapshot.prompt!==response.prompt||currentTask.snapshot.name!==response.name||currentTask.snapshot.providerId!==response.providerId||currentTask.snapshot.model!==response.model||!equal(currentTask.snapshot.options,response.options)||!equal(imageEditFields(currentTask.snapshot),imageEditFields(response)))invalid();
  if(currentTask.dto.versionId)createOwnedMediaGraphReader(db,input.projectId).imageVersion(currentTask.dto.versionId);
  return response;
 }
 function requestGet(input){
  project(input.projectId);
  const row=db.prepare(`SELECT ${requestColumns} FROM image_requests WHERE requestId=? AND projectId=?`).get(input.requestId,input.projectId);if(!row)return null;
  let original;try{original=JSON.parse(row.canonicalInput);}catch{invalid();}
  if(!imageSchemas[row.operation]?.safeParse(original).success||original.projectId!==input.projectId||original.requestId!==input.requestId)invalid();
  const response=prior(row.operation,original),value={projectId:input.projectId,requestId:input.requestId,operation:row.operation,response};if(!imageRequestResponseSchema.safeParse(value).success)invalid();return value;
 }
 const sign=text=>createHmac('sha256',secret).update(text).digest('base64url');
 function page(operation,input){
  project(input.projectId);if(input.groupId)group(input.projectId,input.groupId);
  const limit=input.limit??IMAGE_LIMITS.pageSize,table=operation==='image.task.list'?'image_tasks':operation==='image.group.list'?'image_groups':'image_versions',versions=table==='image_versions';
  const scope=[operation,input.projectId,input.groupId??null,limit];let after=null;
  if(input.cursor){try{const [body,mac,...rest]=input.cursor.split('.');if(rest.length||mac.length!==43||!timingSafeEqual(Buffer.from(mac),Buffer.from(sign(body))))throw Error();const decoded=JSON.parse(Buffer.from(body,'base64url').toString());if(!equal(decoded.slice(0,4),scope)||decoded.length!==5)throw Error();after=decoded[4];if(versions?!Number.isSafeInteger(after)||after<1:!Array.isArray(after)||after.length!==2||typeof after[0]!=='string'||after[0].length>40||!/^[-a-f0-9]{36}$/i.test(after[1]))throw Error();}catch{throw new AppError('INVALID_CURSOR','图像分页游标无效或已过期',400);}}
  const where=['projectId=?'],args=[input.projectId];if(input.groupId){where.push('groupId=?');args.push(input.groupId);}if(after!==null){where.push(versions?'number<?':'(createdAt<? OR (createdAt=? AND id<?))');args.push(...(versions?[after]:[after[0],after[0],after[1]]));}
  const rows=db.prepare(`SELECT ${bounded('id',36)},${versions?'number':bounded('createdAt',40)} FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${versions?'number DESC':'createdAt DESC,id DESC'} LIMIT ?`).all(...args,limit+1),selected=rows.slice(0,limit);
  const items=selected.map(row=>versions?createOwnedMediaGraphReader(db,input.projectId).imageVersion(row.id):table==='image_tasks'?taskDto(input.projectId,row.id):group(input.projectId,row.id));
  let nextCursor=null;if(rows.length>limit){const last=selected.at(-1),body=Buffer.from(JSON.stringify([...scope,versions?last.number:[last.createdAt,last.id]])).toString('base64url');nextCursor=`${body}.${sign(body)}`;}
  return {projectId:input.projectId,items,nextCursor};
 }
 const snapshotRead=read=>input=>{const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');try{return read(input);}finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}};
 const readHandlers={'image.request.get':requestGet,'image.task.get':input=>taskDto(input.projectId,input.taskId),'image.group.get':input=>group(input.projectId,input.groupId),...Object.fromEntries(['image.task.list','image.group.list','image.version.list'].map(operation=>[operation,input=>page(operation,input)]))};
 const handlers=Object.freeze(Object.fromEntries(Object.entries(readHandlers).map(([operation,read])=>[operation,input=>{
  if(!schemaPresent())fail('IMAGE_SCHEMA_REQUIRED',503);
  return snapshotRead(read)(parse(operation,input));
 }])));
 return Object.freeze({handlers,schemaPresent,project,reader,task,group,taskDto,reviewBinding,prior});
}
