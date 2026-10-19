import {AppError,schemas,isReferenceMutationResponse,isReferenceShotRecord,isReferenceEdgeRecord,REFERENCE_RESPONSE_BYTES} from '@mioon/contracts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import type {DatabaseSync} from 'node:sqlite';

type RefRecord = Record<string, unknown>;
interface RefInput {
 [key: string]: unknown;
 projectId: string;requestId?: string;
 sourceNodeId?: string;targetShotId?: string;edgeId?: string;role?: string;
 expectedSourceRevision?: number;expectedShotRevision?: number;
}
interface RefState {transactionEntered: boolean;callbackFailed: boolean;receiptAbsent: boolean;writesStarted: boolean;callbackError?: unknown}
interface RefOwnedOptions {optional?: boolean}
interface RefShotRecord {[key: string]: unknown;id: string;projectId: string;referenceAssetIds: string[];lastFrameAssetId?: string|null;selectedVersionId?: string|null;revision: number}
interface RefEdgeRecord {[key: string]: unknown;id: string;projectId: string;source: string;target: string;kind?: string;role?: string;sourceAssetId?: string}
interface RefNodeRecord {[key: string]: unknown;id: string;projectId: string;revision: number;createdAt: string;type?: string;assetId?: string|null}
interface ReferenceRecoveryBoundary {
 project(): unknown;
 node(id: unknown): RefNodeRecord;
 shot(id: unknown): RefShotRecord;
 asset(id: unknown): RefRecord;
 managed(source: RefRecord): RefRecord;
 edge(id: unknown,options?: RefOwnedOptions): RefRecord|null;
 bindings(value: RefShotRecord): RefRecord[];
 response(operation: string,value: unknown,options?: {historical?: boolean}): unknown;
 replay(operation: string,text: string): unknown;
 validateResponse(operation: string,value: unknown): unknown;
}

const object=(value: unknown): value is RefRecord=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value: unknown): value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const bounded=(column: string,bytes: number): string=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END`;
const identity=(column: string): string=>`${bounded(column,36)} AS ${column}`;
const definite=new Set<string>(['REVISION_CONFLICT','REFERENCE_CONNECTED','REFERENCE_SELECTION_EXISTS','INVALID_REFERENCE_SOURCE','INVALID_REFERENCE_EDGE','REFERENCE_REVISION_LIMIT']);
export const invalidReference: ()=>never=()=>{throw new AppError('INVALID_REFERENCE_RECORD','参考连线或关联记录不可用，请先检查项目',409);};

// A row's existence, not its decoded truthiness, reserves the historical key.
// SQLite bounds the bytes before they enter JavaScript, including corrupt blobs.
export function readReferenceReceipt(db: DatabaseSync,input: RefInput): {requestHash?: string;response?: string}|undefined{
 const row=db.prepare(`SELECT ${bounded('requestHash',64)} AS requestHash,${bounded('response',REFERENCE_RESPONSE_BYTES)} AS response FROM reference_requests WHERE requestId=?`).get(input.requestId as string);
 if(row&&(typeof row.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(row.requestHash)||typeof row.response!=='string'))invalidReference();
 return row as {requestHash?: string;response?: string}|undefined;
}
export function rejectReferenceMutation(db: DatabaseSync,operation: string,input: RefInput,error: unknown,state: RefState): void{
 if(state.transactionEntered&&state.callbackFailed&&state.receiptAbsent&&!state.writesStarted&&!db.isTransaction&&
    error===state.callbackError&&error instanceof AppError&&definite.has(error.code))
  error.details={...(error.details as Record<string,unknown>|undefined),mutationOutcome:'not_applied',operation,projectId:input.projectId,requestId:input.requestId};
}

// Database metadata only: no file reads, probes, media processes or providers.
// Every boundary is scoped to one locked snapshot; construct a fresh one after
// writes so SQLite triggers cannot hide a changed owner behind a reader cache.
export function createReferenceRecoveryBoundary(db: DatabaseSync,input: RefInput): ReferenceRecoveryBoundary{
 const projectId=input.projectId;
 const guarded=<T>(fn: ()=>T): T=>{try{return fn();}catch(error){if(['INSPECTION_UNAVAILABLE','INSPECTION_BUDGET_EXCEEDED'].includes((error as {code?: string}).code as string))invalidReference();throw error;}};
 let media: ReturnType<typeof createOwnedMediaGraphReader>|undefined;
 function project(){
  owned('projects',projectId);
  return media??=guarded(()=>createOwnedMediaGraphReader(db,projectId));
 }
 function owned(table: string,id: unknown,{optional=false}: RefOwnedOptions={}): RefRecord|null{
  if(!['projects','nodes','shots','edges'].includes(table)||!uuid(id))invalidReference();
  const row=db.prepare(`SELECT ${identity('id')}${table==='projects'?'':','+identity('projectId')},${bounded('data',(INSPECTION_ROW_LIMITS as Record<string,number>)[table])} AS data FROM ${table} WHERE id=?`).get(id as string) as RefRecord|undefined;
  if(!row&&optional)return null;
  // Never decode a foreign SQL owner's JSON or expose its conflict details.
  if(!row||row.id!==id||(table!=='projects'&&row.projectId!==projectId)||typeof row.data!=='string')invalidReference();
  let value;try{value=JSON.parse(row.data);}catch{invalidReference();}
  if(!object(value)||value.id!==id||(table==='projects'?id!==projectId:value.projectId!==projectId))invalidReference();
  return value;
 }
 function asset(id: unknown): RefRecord{return guarded(()=>project().asset(id)) as RefRecord;}
 function node(id: unknown): RefNodeRecord{
  const value=owned('nodes',id) as RefNodeRecord,{id:recordId,revision,createdAt,...fields}=value;
  if(!Number.isSafeInteger(revision)||revision<1||typeof createdAt!=='string'||createdAt.length<1||createdAt.length>40||
     !(schemas as Record<string,{safeParse(value: unknown):{success: boolean}}>)['node.create'].safeParse(fields).success||Object.hasOwn(fields,'requestId'))invalidReference();
  if(value.assetId!==undefined)asset(value.assetId);
  return value;
 }
 function shotRelations(value: unknown): RefShotRecord{
  const record=value as RefShotRecord;
  if(!isReferenceShotRecord(value,{projectId}))invalidReference();
  for(const id of record.referenceAssetIds)asset(id);
  if(record.lastFrameAssetId!=null){const tail=asset(record.lastFrameAssetId);if(!['image/png','image/jpeg','image/webp'].includes(tail.mimeType as string))invalidReference();}
  if(record.selectedVersionId!==null)guarded(()=>project().version(record.selectedVersionId,record.id));
  return record;
 }
 function shot(id: unknown): RefShotRecord{return shotRelations(owned('shots',id));}
 function managed(source: RefRecord): RefRecord{
  const value=asset(source.assetId);
  if(!['image/png','image/jpeg','image/webp'].includes(value.mimeType as string)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||
     typeof value.relativePath!=='string'||value.relativePath.length>4096||!value.relativePath.startsWith('media/')||
     /[\\\0]/.test(value.relativePath)||value.relativePath.split('/').some(part=>!part||part==='.'||part==='..'))
   throw new AppError('INVALID_REFERENCE_SOURCE','首帧必须为已导入的托管 PNG、JPEG 或 WebP 图片');
  return value;
 }
 function edgeRelations(value: unknown): RefEdgeRecord{
  const record=value as RefEdgeRecord;
  if(!isReferenceEdgeRecord(value,{projectId}))invalidReference();
  const source=node(record.source);
  if(source.type!=='image'||source.assetId!==record.sourceAssetId)invalidReference();
  asset(record.sourceAssetId as string);shot(record.target);
  try{managed(source);}catch(error){if(error instanceof AppError)invalidReference();throw error;}
  return record;
 }
 function edge(id: unknown,{optional=false}: RefOwnedOptions={}): RefRecord|null{
  const value=owned('edges',id,{optional});
  if(value===null)return null;
  if(value.kind==='reference')return edgeRelations(value);
  // Decorative edges can legitimately use either canvas shots or nodes. Check
  // both owners before allowing the definitive INVALID_REFERENCE_EDGE result.
  if(Object.keys(value).some(key=>!['id','projectId','source','target','kind'].includes(key))||
     value.kind!==undefined&&value.kind!=='decorative'||!uuid(value.source)||!uuid(value.target))invalidReference();
  for(const id of [value.source,value.target]){
   const isNode=Boolean(db.prepare('SELECT 1 FROM nodes WHERE id=?').get(id)),isShot=Boolean(db.prepare('SELECT 1 FROM shots WHERE id=?').get(id));
   if(isNode===isShot)invalidReference();
   if(isNode)node(id);else shot(id);
  }
  return value;
 }
 function bindings(value: RefRecord): RefRecord[]{
  // Return at most two target candidates. A malformed project edge cannot be
  // silently skipped, and a foreign SQL row claiming this target is rejected.
  const safe=`CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.edges} THEN CASE WHEN json_valid(data) AND json_type(data)='object' THEN data END END`;
  const rows=db.prepare(`SELECT ${identity('id')} FROM edges WHERE
   (projectId=? AND (${safe}) IS NULL) OR
   (json_extract((${safe}),'$.kind')='reference' AND json_extract((${safe}),'$.target')=?) LIMIT 2`).all(projectId,value.id as string);
  return rows.map(row=>edge(row.id)).filter((value): value is RefRecord=>value!==null);
 }
 function response(operation: string,value: unknown,{historical=false}: {historical?: boolean}={}): unknown{
  if(!isReferenceMutationResponse(operation,input as never,value))invalidReference();
  project();
  // Validate retained relations and current stable owners independently. The
  // shot may now be rebound, have a newer revision, or select another version.
  const record=value as unknown as {shot: RefShotRecord;edge: RefEdgeRecord};
  shotRelations(record.shot);edgeRelations(record.edge);
  const current=shot(record.shot.id),existing=edge(record.edge.id,{optional:true});
  if(existing&&['id','projectId','source','target','kind','role','sourceAssetId'].some(key=>existing[key]!==record.edge[key]))invalidReference();
  if(!historical){
   const currentBindings=bindings(current);
   if(operation==='reference.attach'?(currentBindings.length!==1||currentBindings[0].id!==record.edge.id):currentBindings.length!==0)invalidReference();
   if(JSON.stringify(current)!==JSON.stringify(record.shot))invalidReference();
   if(operation==='reference.attach'?(JSON.stringify(existing)!==JSON.stringify(record.edge)):existing!==null)invalidReference();
  }
  return value;
 }
 function replay(operation: string,text: string): unknown{
  let value;try{value=JSON.parse(text);}catch{invalidReference();}
  try{return response(operation,value,{historical:true});}
  catch(error){if(error instanceof AppError)invalidReference();throw error;}
 }
 function validateResponse(operation: string,value: unknown): unknown{
  if(!isReferenceMutationResponse(operation,input as never,value))invalidReference();
  const record=value as {shot: unknown;edge: unknown};
  shotRelations(record.shot);edgeRelations(record.edge);return value;
 }
 return {project,node,shot,asset,managed,edge,bindings,response,replay,validateResponse};
}
