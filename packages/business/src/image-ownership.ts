import {createOwnedMediaGraphReader} from './inspection.ts';
import {imageEditFields} from './images/edit-source.ts';
import {validateComfyReceiptOwnership} from './comfy/ownership.ts';
import {validateImageTaskReview} from './images/reviews.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '@mioon/contracts';
import {canonicalImageInput as canonical,IMAGE_LIMITS,IMAGE_UNRESOLVED_STATES,imageSchemas,imageSnapshotSchema,imageReceiptSchema,imageTaskResponseSchema,imageGroupResponseSchema,imageVersionResponseSchema} from '../../contracts/src/images.ts';

type ImageGroup=ReturnType<typeof imageGroupResponseSchema.parse>;
type ImageTaskResponse=ReturnType<typeof imageTaskResponseSchema.parse>;
type ImageSnapshot=ReturnType<typeof imageSnapshotSchema.parse>;
type ImageReceipt=ReturnType<typeof imageReceiptSchema.parse>;
type ImageVersionResponse=ReturnType<typeof imageVersionResponseSchema.parse>;
type ImageInput=ReturnType<(typeof imageSchemas)['image.generate']['parse']>;
type ZodLike<T>={safeParse(value: unknown): {success: true; data: T} | {success: false; error: unknown}};
type Json=Record<string, unknown>;

export interface ImageTaskRow {
 readonly id: string;
 readonly projectId: string;
 readonly groupId: string;
 readonly requestId: string;
 readonly inputHash: string;
 readonly input: string;
 readonly snapshot: string;
 readonly state: string;
 readonly revision: number;
 readonly dispatched: number;
 readonly stagedReceipt: string | null;
 readonly versionId: string | null;
 readonly errorCode: string | null;
 readonly createdAt: string;
 readonly updatedAt: string;
}
export interface ImageTaskView {
 readonly row: ImageTaskRow;
 readonly dto: ImageTaskResponse;
 readonly snapshot: ImageSnapshot;
 readonly input: ImageInput;
 readonly receipt: ImageReceipt | null;
}
export interface ImageSourceIdentity {
 readonly imageGroupId: string;
 readonly imageTaskId: string;
 readonly imageVersionId: string;
}
export interface ImageOwnershipReader {
 group(id: string): ImageGroup;
 task(id: string,options?: {shallow?: boolean}): ImageTaskView;
 version(id: string,asset?: Json | null): ImageVersionResponse;
 owners(assetId: string): unknown[];
 source(id: string,asset?: Json | null): ImageSourceIdentity;
}
export interface ImageOwnershipOptions {
 consume?: (value: string)=>void;
 fail?: ()=>never;
 validateSource?: (taskId: string)=>unknown;
}

function unavailable(): never {throw new AppError('INSPECTION_UNAVAILABLE','Inspection data is unavailable',404);}
const same=(a: unknown,b: unknown): boolean=>canonical(a)===canonical(b);
// All SQL columns are bounded before crossing the JS boundary. Invalid nullable
// columns become a non-null sentinel, so corruption cannot erase a relation.
const text=(name: string,max: number,nullable=false): string=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}) THEN ${name} ELSE 0 END AS ${name}`;
const numeric=(name: string): string=>`CASE WHEN typeof(${name})='integer' AND ${name} BETWEEN 1 AND 9007199254740991 THEN ${name} ELSE 0 END AS ${name}`;
const groupColumns=['id','projectId'].map(v=>text(v,36)).concat(text('name',480),numeric('revision'),text('headVersionId',36,true),text('activeTaskId',36,true),text('createdAt',40),text('updatedAt',40)).join(',');
const taskColumns=['id','projectId','groupId'].map(v=>text(v,36)).concat(text('requestId',800),text('inputHash',64),text('input',IMAGE_LIMITS.inputBytes),text('snapshot',IMAGE_LIMITS.snapshotBytes),text('state',40),numeric('revision'),`CASE WHEN dispatched IN (0,1) THEN dispatched ELSE -1 END AS dispatched`,text('stagedReceipt',IMAGE_LIMITS.receiptBytes,true),text('versionId',36,true),text('errorCode',80,true),text('createdAt',40),text('updatedAt',40)).join(',');
const versionColumns=['id','projectId','groupId','taskId','assetId'].map(v=>text(v,36)).concat(numeric('number'),text('data',IMAGE_LIMITS.versionBytes)).join(',');
const rowValue=(value: unknown): unknown=>value;
const property=(value: unknown,key: string): unknown=>value!==null&&typeof value==='object'&&key in value?(value as Json)[key]:undefined;

// Backend-only reader. It never heals, starts work, reads private files or exposes
// the input/receipt to callers. The parent supplies the shared inspection budget.
export function createImageOwnershipReader(db: DatabaseSync,projectId: string,{consume=(): void=>{},fail=unavailable,validateSource}: ImageOwnershipOptions={}): ImageOwnershipReader {
 const reject: ()=>never=fail;
 function decodeWith<T>(schema: ZodLike<T>,value: unknown): T {
  if(typeof value!=='string')reject();consume(value);
  let parsed: unknown;try{parsed=JSON.parse(value);}catch{reject();}
  const result=schema.safeParse(parsed);if(!result.success)reject();return result.data;
 }
 const available=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_versions'").get());
 if(!available&&db.prepare('SELECT 1 FROM schema_version WHERE version=16').get())reject();
 const groups=new Map<string,ImageGroup>(),tasks=new Map<string,ImageTaskView>(),versions=new Map<string,ImageVersionResponse>(),validatedTasks=new Set<string>();
 const checkSource=(value: ImageTaskView): ImageTaskView=>{if(property(value.input,'purpose')!=='edit'||validatedTasks.has(value.row.id))return value;try{(validateSource??((taskId: string)=>createOwnedMediaGraphReader(db,projectId).imageTask(taskId)))(value.row.id);validatedTasks.add(value.row.id);return value;}catch{reject();}};
 function group(id: string): ImageGroup {
  const cached=groups.get(id);if(cached)return cached;
  const raw=db.prepare(`SELECT ${groupColumns} FROM image_groups WHERE id=? LIMIT 1`).get(id);consume(raw?JSON.stringify(raw):'');
  if(!raw||!imageGroupResponseSchema.safeParse(raw).success||raw.id!==id||raw.projectId!==projectId)reject();
  const row=raw as unknown as ImageGroup;groups.set(id,row);return row;
 }
 function task(id: string,{shallow=false}: {shallow?: boolean}={}): ImageTaskView {
  const cached=tasks.get(id);if(cached)return shallow?cached:checkSource(cached);
  const raw=db.prepare(`SELECT ${taskColumns} FROM image_tasks WHERE id=? LIMIT 1`).get(id);if(!raw||raw.id!==id||raw.projectId!==projectId)reject();
  const row=raw as unknown as ImageTaskRow;
  const input=decodeWith(imageSchemas['image.generate'],row.input),snapshot=decodeWith(imageSnapshotSchema,row.snapshot),
   receipt=row.stagedReceipt===null?null:decodeWith(imageReceiptSchema,row.stagedReceipt);
  if(receipt&&(snapshot.providerId==='comfy-local'?(receipt.schemaVersion!==2||property(receipt,'providerId')!=='comfy-local'||receipt.width!==512||receipt.height!==512):(receipt.schemaVersion!==1||receipt.width!==1024||receipt.height!==1024)))reject();
  if(createHash('sha256').update(canonical(input)).digest('hex')!==row.inputHash||input.requestId!==row.requestId||input.projectId!==projectId||snapshot.projectId!==projectId||snapshot.taskId!==id||snapshot.groupId!==row.groupId||input.groupId!==undefined&&input.groupId!==row.groupId)reject();
  if(!same({...snapshot,schemaVersion:undefined,projectId:undefined,groupId:undefined,taskId:undefined,sourceImage:undefined},{...imageEditFields(input),name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options}))reject();
  const dto: ImageTaskResponse={id:row.id,projectId,groupId:row.groupId,requestId:row.requestId,name:snapshot.name,prompt:snapshot.prompt,providerId:snapshot.providerId,model:snapshot.model,options:snapshot.options,...imageEditFields(snapshot),state:row.state,revision:row.revision,dispatched:row.dispatched===1,versionId:row.versionId,errorCode:row.errorCode,createdAt:row.createdAt,updatedAt:row.updatedAt} as ImageTaskResponse;
  if(![0,1].includes(row.dispatched)||!imageTaskResponseSchema.safeParse(dto).success)reject();
  if(receipt&&(receipt.taskId!==id||receipt.projectId!==projectId||receipt.groupId!==row.groupId||receipt.inputHash!==row.inputHash||property(receipt,'isMock')!==(snapshot.providerId==='mock')))reject();
  const owner=group(row.groupId);if(snapshot.name!==owner.name)reject();
  if(typeof row.state!=='string'||(IMAGE_UNRESOLVED_STATES.includes(row.state)?owner.activeTaskId!==id:owner.activeTaskId===id))reject();
  if(['persisting','local_result_error','succeeded'].includes(row.state)&&!receipt)reject();
  if(receipt&&input.providerId==='comfy-local')validateComfyReceiptOwnership(db,row,input,receipt,{fail,consume});
  const result: ImageTaskView={row,dto,snapshot,input,receipt};tasks.set(id,result);return shallow?result:checkSource(result);
 }
 function rawVersion(id: string): ImageVersionResponse {
  const raw=db.prepare(`SELECT ${versionColumns} FROM image_versions WHERE id=? LIMIT 1`).get(id);
  if(!raw||raw.id!==id||raw.projectId!==projectId)reject();
  const value=decodeWith(imageVersionResponseSchema,rowValue(raw.data));
  if(['id','projectId','groupId','taskId','assetId','number'].some(key=>property(value,key)!==raw[key]))reject();return value;
 }
 function assetMatches(value: ImageVersionResponse,asset: Json | null | undefined): void {
  if(asset&&(asset.id!==value.assetId||asset.projectId!==projectId||asset.sha256!==value.sha256||asset.mimeType!==value.mimeType||asset.width!==value.width||asset.height!==value.height||asset.sizeBytes!==value.byteLength||asset.provenance!==(value.isMock?'synthetic-mock':'generated')))reject();
 }
 function version(id: string,asset?: Json | null): ImageVersionResponse {
  const cached=versions.get(id);if(cached){assetMatches(cached,asset);return cached;}
  const value=rawVersion(id),owner=group(value.groupId),source=task(value.taskId),receipt=source.receipt;
  if(source.row.groupId!==value.groupId||source.row.state!=='succeeded'||source.row.versionId!==value.id||!receipt||receipt.versionId!==value.id||receipt.assetId!==value.assetId||value.number>owner.revision||owner.headVersionId===null)reject();
  for(const key of ['sha256','mimeType','width','height','byteLength','isMock'])if(property(value,key)!==property(receipt,key))reject();
  validateImageTaskReview(db,projectId,source.row.id,source.input,{consume});
  if(value.providerId!==source.snapshot.providerId||value.model!==source.snapshot.model||!same(value.options,source.snapshot.options)||!same(imageEditFields(value),imageEditFields(source.snapshot)))reject();
  const head=owner.headVersionId===value.id?value:rawVersion(owner.headVersionId);
  if(head.groupId!==value.groupId||head.number<value.number||head.number>owner.revision)reject();
  if(owner.activeTaskId!==null)task(owner.activeTaskId,{shallow:true});
  assetMatches(value,asset);
  versions.set(id,value);return value;
 }
 function owners(assetId: string): unknown[] {
  if(!available)return [];
  const rows=db.prepare(`SELECT ${text('id',36)} FROM image_versions WHERE assetId=? OR CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=? ORDER BY id LIMIT 2`).all(assetId,assetId);
  const owningTasks=db.prepare(`SELECT ${text('id',36)},${text('projectId',36)},${text('versionId',36,true)} FROM image_tasks WHERE CASE WHEN json_valid(stagedReceipt) THEN json_extract(stagedReceipt,'$.assetId') END=? ORDER BY id LIMIT 2`).all(assetId);
  consume(JSON.stringify(rows));consume(JSON.stringify(owningTasks));
  if(owningTasks.length>1||owningTasks.some(task=>task.projectId!==projectId||rows.length!==1||(rows[0]&&task.versionId!==rows[0].id)))reject();
  return rows;
 }
 return {owners,version,group,task,source:(id: string,asset?: Json | null)=>{const value=version(id,asset);return {imageGroupId:value.groupId,imageTaskId:value.taskId,imageVersionId:value.id};}};
}
