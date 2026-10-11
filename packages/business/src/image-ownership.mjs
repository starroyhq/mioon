import {createOwnedMediaGraphReader} from './inspection.mjs';
import {imageEditFields} from './images/edit-source.mjs';
import {validateComfyReceiptOwnership} from './comfy/ownership.mjs';
import {validateImageTaskReview} from './images/reviews.mjs';
import {createHash} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {canonicalImageInput as canonical,IMAGE_LIMITS,IMAGE_UNRESOLVED_STATES,imageSchemas,imageSnapshotSchema,imageReceiptSchema,imageTaskResponseSchema,imageGroupResponseSchema,imageVersionResponseSchema} from '../../contracts/src/images.mjs';

const unavailable=()=>{throw new AppError('INSPECTION_UNAVAILABLE','Inspection data is unavailable',404);};
const same=(a,b)=>canonical(a)===canonical(b);
// All SQL columns are bounded before crossing the JS boundary. Invalid nullable
// columns become a non-null sentinel, so corruption cannot erase a relation.
const text=(name,max,nullable=false)=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}) THEN ${name} ELSE 0 END AS ${name}`;
const numeric=name=>`CASE WHEN typeof(${name})='integer' AND ${name} BETWEEN 1 AND 9007199254740991 THEN ${name} ELSE 0 END AS ${name}`;
const groupColumns=['id','projectId'].map(v=>text(v,36)).concat(text('name',480),numeric('revision'),text('headVersionId',36,true),text('activeTaskId',36,true),text('createdAt',40),text('updatedAt',40)).join(',');
const taskColumns=['id','projectId','groupId'].map(v=>text(v,36)).concat(text('requestId',800),text('inputHash',64),text('input',IMAGE_LIMITS.inputBytes),text('snapshot',IMAGE_LIMITS.snapshotBytes),text('state',40),numeric('revision'),`CASE WHEN dispatched IN (0,1) THEN dispatched ELSE -1 END AS dispatched`,text('stagedReceipt',IMAGE_LIMITS.receiptBytes,true),text('versionId',36,true),text('errorCode',80,true),text('createdAt',40),text('updatedAt',40)).join(',');
const versionColumns=['id','projectId','groupId','taskId','assetId'].map(v=>text(v,36)).concat(numeric('number'),text('data',IMAGE_LIMITS.versionBytes)).join(',');

// Backend-only reader. It never heals, starts work, reads private files or exposes
// the input/receipt to callers. The parent supplies the shared inspection budget.
export function createImageOwnershipReader(db,projectId,{consume=()=>{},fail=unavailable,validateSource}={}){
 const decode=(value,schema)=>{if(typeof value!=='string')fail();consume(value);let parsed;try{parsed=JSON.parse(value);}catch{fail();}const result=schema.safeParse(parsed);if(!result.success)fail();return result.data;};
 const available=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_versions'").get());
 if(!available&&db.prepare('SELECT 1 FROM schema_version WHERE version=16').get())fail();
 const groups=new Map(),tasks=new Map(),versions=new Map(),validatedTasks=new Set();
 const checkSource=value=>{if(value.input.purpose!=='edit'||validatedTasks.has(value.row.id))return value;try{(validateSource??(id=>createOwnedMediaGraphReader(db,projectId).imageTask(id)))(value.row.id);validatedTasks.add(value.row.id);return value;}catch{fail();}};
 function group(id){
  if(groups.has(id))return groups.get(id);
  const row=db.prepare(`SELECT ${groupColumns} FROM image_groups WHERE id=? LIMIT 1`).get(id);consume(row?JSON.stringify(row):'');
  if(!imageGroupResponseSchema.safeParse(row).success||row.id!==id||row.projectId!==projectId)fail();groups.set(id,row);return row;
 }
 function task(id,{shallow=false}={}){
  if(tasks.has(id))return shallow?tasks.get(id):checkSource(tasks.get(id));
  const row=db.prepare(`SELECT ${taskColumns} FROM image_tasks WHERE id=? LIMIT 1`).get(id);if(!row||row.id!==id||row.projectId!==projectId)fail();
  const input=decode(row.input,imageSchemas['image.generate']),snapshot=decode(row.snapshot,imageSnapshotSchema),receipt=row.stagedReceipt===null?null:decode(row.stagedReceipt,imageReceiptSchema);
  if(receipt&&(snapshot.providerId==='comfy-local'?(receipt.schemaVersion!==2||receipt.providerId!=='comfy-local'||receipt.width!==512||receipt.height!==512):(receipt.schemaVersion!==1||receipt.width!==1024||receipt.height!==1024)))fail();
  if(createHash('sha256').update(canonical(input)).digest('hex')!==row.inputHash||input.requestId!==row.requestId||input.projectId!==projectId||snapshot.projectId!==projectId||snapshot.taskId!==id||snapshot.groupId!==row.groupId||input.groupId!==undefined&&input.groupId!==row.groupId)fail();
  if(!same({...snapshot,schemaVersion:undefined,projectId:undefined,groupId:undefined,taskId:undefined,sourceImage:undefined},{...imageEditFields(input),name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options}))fail();
  const dto={id:row.id,projectId,groupId:row.groupId,requestId:row.requestId,name:snapshot.name,prompt:snapshot.prompt,providerId:snapshot.providerId,model:snapshot.model,options:snapshot.options,...imageEditFields(snapshot),state:row.state,revision:row.revision,dispatched:row.dispatched===1,versionId:row.versionId,errorCode:row.errorCode,createdAt:row.createdAt,updatedAt:row.updatedAt};
  if(![0,1].includes(row.dispatched)||!imageTaskResponseSchema.safeParse(dto).success)fail();
  if(receipt&&(receipt.taskId!==id||receipt.projectId!==projectId||receipt.groupId!==row.groupId||receipt.inputHash!==row.inputHash||receipt.isMock!==(snapshot.providerId==='mock')))fail();
  const owner=group(row.groupId);if(snapshot.name!==owner.name)fail();
  if(IMAGE_UNRESOLVED_STATES.includes(row.state)?owner.activeTaskId!==id:owner.activeTaskId===id)fail();
  if(['persisting','local_result_error','succeeded'].includes(row.state)&&!receipt)fail();
  if(receipt&&input.providerId==='comfy-local')validateComfyReceiptOwnership(db,row,input,receipt,{fail,consume});
  const result={row,dto,snapshot,input,receipt};tasks.set(id,result);return shallow?result:checkSource(result);
 }
 function rawVersion(id){
  const row=db.prepare(`SELECT ${versionColumns} FROM image_versions WHERE id=? LIMIT 1`).get(id);
  if(!row||row.id!==id||row.projectId!==projectId)fail();const value=decode(row.data,imageVersionResponseSchema);
  if(['id','projectId','groupId','taskId','assetId','number'].some(key=>value[key]!==row[key]))fail();return value;
 }
 function assetMatches(value,asset){
  if(asset&&(asset.id!==value.assetId||asset.projectId!==projectId||asset.sha256!==value.sha256||asset.mimeType!==value.mimeType||asset.width!==value.width||asset.height!==value.height||asset.sizeBytes!==value.byteLength||asset.provenance!==(value.isMock?'synthetic-mock':'generated')))fail();
 }
 function version(id,asset){
  if(versions.has(id)){const value=versions.get(id);assetMatches(value,asset);return value;}
  const value=rawVersion(id),owner=group(value.groupId),source=task(value.taskId),receipt=source.receipt;
  if(source.row.groupId!==value.groupId||source.row.state!=='succeeded'||source.row.versionId!==value.id||!receipt||receipt.versionId!==value.id||receipt.assetId!==value.assetId||value.number>owner.revision||owner.headVersionId===null)fail();
  for(const key of ['sha256','mimeType','width','height','byteLength','isMock'])if(value[key]!==receipt[key])fail();
  validateImageTaskReview(db,projectId,source.row.id,source.input,{consume});
  if(value.providerId!==source.snapshot.providerId||value.model!==source.snapshot.model||!same(value.options,source.snapshot.options)||!same(imageEditFields(value),imageEditFields(source.snapshot)))fail();
  const head=owner.headVersionId===value.id?value:rawVersion(owner.headVersionId);
  if(head.groupId!==value.groupId||head.number<value.number||head.number>owner.revision)fail();
  if(owner.activeTaskId!==null)task(owner.activeTaskId,{shallow:true});
  assetMatches(value,asset);
  versions.set(id,value);return value;
 }
 function owners(assetId){
  if(!available)return [];
  const rows=db.prepare(`SELECT ${text('id',36)} FROM image_versions WHERE assetId=? OR CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=? ORDER BY id LIMIT 2`).all(assetId,assetId);
  const tasks=db.prepare(`SELECT ${text('id',36)},${text('projectId',36)},${text('versionId',36,true)} FROM image_tasks WHERE CASE WHEN json_valid(stagedReceipt) THEN json_extract(stagedReceipt,'$.assetId') END=? ORDER BY id LIMIT 2`).all(assetId);
  consume(JSON.stringify(rows));consume(JSON.stringify(tasks));
  if(tasks.length>1||tasks.some(task=>task.projectId!==projectId||rows.length!==1||task.versionId!==rows[0].id))fail();
  return rows;
 }
 return {owners,version,group,task,source:(id,asset)=>{const value=version(id,asset);return {imageGroupId:value.groupId,imageTaskId:value.taskId,imageVersionId:value.id};}};
}
