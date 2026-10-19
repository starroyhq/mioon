import {AppError,schemas,isReferenceMutationResponse,isReferenceShotRecord,isReferenceEdgeRecord,REFERENCE_RESPONSE_BYTES} from '@mioon/contracts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const bounded=(column,bytes)=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END`;
const identity=column=>`${bounded(column,36)} AS ${column}`;
const definite=new Set(['REVISION_CONFLICT','REFERENCE_CONNECTED','REFERENCE_SELECTION_EXISTS','INVALID_REFERENCE_SOURCE','INVALID_REFERENCE_EDGE','REFERENCE_REVISION_LIMIT']);
export const invalidReference=()=>{throw new AppError('INVALID_REFERENCE_RECORD','参考连线或关联记录不可用，请先检查项目',409);};

// A row's existence, not its decoded truthiness, reserves the historical key.
// SQLite bounds the bytes before they enter JavaScript, including corrupt blobs.
export function readReferenceReceipt(db,input){
 const row=db.prepare(`SELECT ${bounded('requestHash',64)} AS requestHash,${bounded('response',REFERENCE_RESPONSE_BYTES)} AS response FROM reference_requests WHERE requestId=?`).get(input.requestId);
 if(row&&(typeof row.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(row.requestHash)||typeof row.response!=='string'))invalidReference();
 return row;
}
export function rejectReferenceMutation(db,operation,input,error,state){
 if(state.transactionEntered&&state.callbackFailed&&state.receiptAbsent&&!state.writesStarted&&!db.isTransaction&&
    error===state.callbackError&&error instanceof AppError&&definite.has(error.code))
  error.details={...error.details,mutationOutcome:'not_applied',operation,projectId:input.projectId,requestId:input.requestId};
}

// Database metadata only: no file reads, probes, media processes or providers.
// Every boundary is scoped to one locked snapshot; construct a fresh one after
// writes so SQLite triggers cannot hide a changed owner behind a reader cache.
export function createReferenceRecoveryBoundary(db,input){
 const projectId=input.projectId;
 const guarded=fn=>{try{return fn();}catch(error){if(['INSPECTION_UNAVAILABLE','INSPECTION_BUDGET_EXCEEDED'].includes(error.code))invalidReference();throw error;}};
 let media;
 function project(){
  owned('projects',projectId);
  return media??=guarded(()=>createOwnedMediaGraphReader(db,projectId));
 }
 function owned(table,id,{optional=false}={}){
  if(!['projects','nodes','shots','edges'].includes(table)||!uuid(id))invalidReference();
  const row=db.prepare(`SELECT ${identity('id')}${table==='projects'?'':','+identity('projectId')},${bounded('data',INSPECTION_ROW_LIMITS[table])} AS data FROM ${table} WHERE id=?`).get(id);
  if(!row&&optional)return null;
  // Never decode a foreign SQL owner's JSON or expose its conflict details.
  if(!row||row.id!==id||(table!=='projects'&&row.projectId!==projectId)||typeof row.data!=='string')invalidReference();
  let value;try{value=JSON.parse(row.data);}catch{invalidReference();}
  if(!object(value)||value.id!==id||(table==='projects'?id!==projectId:value.projectId!==projectId))invalidReference();
  return value;
 }
 function asset(id){return guarded(()=>project().asset(id));}
 function node(id){
  const value=owned('nodes',id),{id:recordId,revision,createdAt,...fields}=value;
  if(!Number.isSafeInteger(revision)||revision<1||typeof createdAt!=='string'||createdAt.length<1||createdAt.length>40||
     !schemas['node.create'].safeParse(fields).success||Object.hasOwn(fields,'requestId'))invalidReference();
  if(value.assetId!==undefined)asset(value.assetId);
  return value;
 }
 function shotRelations(value){
  if(!isReferenceShotRecord(value,{projectId}))invalidReference();
  for(const id of value.referenceAssetIds)asset(id);
  if(value.lastFrameAssetId!=null){const tail=asset(value.lastFrameAssetId);if(!['image/png','image/jpeg','image/webp'].includes(tail.mimeType))invalidReference();}
  if(value.selectedVersionId!==null)guarded(()=>project().version(value.selectedVersionId,value.id));
  return value;
 }
 function shot(id){return shotRelations(owned('shots',id));}
 function managed(source){
  const value=asset(source.assetId);
  if(!['image/png','image/jpeg','image/webp'].includes(value.mimeType)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||
     typeof value.relativePath!=='string'||value.relativePath.length>4096||!value.relativePath.startsWith('media/')||
     /[\\\0]/.test(value.relativePath)||value.relativePath.split('/').some(part=>!part||part==='.'||part==='..'))
   throw new AppError('INVALID_REFERENCE_SOURCE','首帧必须为已导入的托管 PNG、JPEG 或 WebP 图片');
  return value;
 }
 function edgeRelations(value){
  if(!isReferenceEdgeRecord(value,{projectId}))invalidReference();
  const source=node(value.source);
  if(source.type!=='image'||source.assetId!==value.sourceAssetId)invalidReference();
  asset(value.sourceAssetId);shot(value.target);
  try{managed(source);}catch(error){if(error instanceof AppError)invalidReference();throw error;}
  return value;
 }
 function edge(id,{optional=false}={}){
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
 function bindings(value){
  // Return at most two target candidates. A malformed project edge cannot be
  // silently skipped, and a foreign SQL row claiming this target is rejected.
  const safe=`CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.edges} THEN CASE WHEN json_valid(data) AND json_type(data)='object' THEN data END END`;
  const rows=db.prepare(`SELECT ${identity('id')} FROM edges WHERE
   (projectId=? AND (${safe}) IS NULL) OR
   (json_extract((${safe}),'$.kind')='reference' AND json_extract((${safe}),'$.target')=?) LIMIT 2`).all(projectId,value.id);
  return rows.map(row=>edge(row.id));
 }
 function response(operation,value,{historical=false}={}){
  if(!isReferenceMutationResponse(operation,input,value))invalidReference();
  project();
  // Validate retained relations and current stable owners independently. The
  // shot may now be rebound, have a newer revision, or select another version.
  shotRelations(value.shot);edgeRelations(value.edge);
  const current=shot(value.shot.id),existing=edge(value.edge.id,{optional:true});
  if(existing&&['id','projectId','source','target','kind','role','sourceAssetId'].some(key=>existing[key]!==value.edge[key]))invalidReference();
  if(!historical){
   const currentBindings=bindings(current);
   if(operation==='reference.attach'?(currentBindings.length!==1||currentBindings[0].id!==value.edge.id):currentBindings.length!==0)invalidReference();
   if(JSON.stringify(current)!==JSON.stringify(value.shot))invalidReference();
   if(operation==='reference.attach'?(JSON.stringify(existing)!==JSON.stringify(value.edge)):existing!==null)invalidReference();
  }
  return value;
 }
 function replay(operation,text){
  let value;try{value=JSON.parse(text);}catch{invalidReference();}
  try{return response(operation,value,{historical:true});}
  catch(error){if(error instanceof AppError)invalidReference();throw error;}
 }
 function validateResponse(operation,value){
  if(!isReferenceMutationResponse(operation,input,value))invalidReference();
  shotRelations(value.shot);edgeRelations(value.edge);return value;
 }
 return {project,node,shot,asset,managed,edge,bindings,response,replay,validateResponse};
}
