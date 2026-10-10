import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {AppError,subjectSchemas,isSubjectResponse,isSubjectVersionResponse,isSubjectBindingResponse,isSubjectMutationResponse,SUBJECT_LIMITS} from '@mioon/contracts';
import {createMutationReplay} from './mutation-replay.mjs';
import {createOwnedMediaGraphReader} from './inspection.mjs';
import {INSPECTION_ROW_LIMITS,INSPECTION_VERSION_ASSET_EXPRESSION} from './inspection-query.mjs';

const missing=()=>{throw new AppError('NOT_FOUND','找不到记录',404);};
const invalid=()=>{throw new AppError('INVALID_SUBJECT_RECORD','主体或关联状态不一致，请先检查项目',409);};
const badCursor=()=>{throw new AppError('INVALID_CURSOR','主体分页游标无效或已过期',400);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const decode=text=>{let value;try{value=JSON.parse(text);}catch{invalid();}if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value;};
const columns=(names)=>names.split(',').map(name=>['revision','number'].includes(name)?`CASE WHEN typeof(${name})='integer' AND ${name} BETWEEN 1 AND 9007199254740991 THEN ${name} END AS ${name}`:`CASE WHEN length(CAST(${name} AS BLOB))<=${name==='name'?480:name==='data'?4096:64} THEN ${name} END AS ${name}`).join(',');
const subjectColumns=columns('id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt');
const versionColumns=columns('id,projectId,subjectId,number,assetId,data');
const bindingColumns=columns('id,projectId,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId,createdAt,updatedAt');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const conflict=(current,expectedRevision)=>{if(current.revision!==expectedRevision)throw new AppError('REVISION_CONFLICT','主体或绑定已有新版本，请重新读取后再修改',409,{entityId:current.id,expectedRevision,currentRevision:current.revision,current});};
const advance=revision=>{if(revision===Number.MAX_SAFE_INTEGER)throw new AppError('SUBJECT_REVISION_LIMIT','主体或绑定版本已达到安全上限',409);};

// The same bounded ownership boundary is used by live calls and durable-task
// recovery. A receipt never grants permission to return missing/foreign data.
export function createSubjectRecoveryBoundary(db,input){
 const projectId=input.projectId,subjects=new Map(),versions=new Map();let graph;
 function legacy(table,id){
  const row=db.prepare(`SELECT id${table==='projects'?'':',projectId'},CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS[table]} THEN data END AS data FROM ${table} WHERE id=?${table==='projects'?'':' AND projectId=?'}`).get(...(table==='projects'?[id]:[id,projectId]));
  if(!row)missing();
  const value=decode(row.data);
  if(table!=='projects'&&value.projectId!==projectId)missing();
  if(value.id!==row.id||(table==='projects'&&value.id!==projectId))invalid();
  return value;
 }
 function project(){return legacy('projects',projectId);}
 function shot(id){return legacy('shots',id);}
 function asset(id){
  legacy('assets',id);
  let value;try{graph??=createOwnedMediaGraphReader(db,projectId);value=graph.asset(id);}catch(error){if(error.code==='INSPECTION_BUDGET_EXCEEDED')throw error;invalid();}
  const relative=value.relativePath;
  if(typeof relative!=='string'||relative.length>4096||!relative.startsWith('media/')||relative.includes('\\')||relative.includes('\0')||relative.split('/').some(part=>!part||part==='.'||part==='..'))invalid();
  if(!['image/png','image/jpeg','image/webp'].includes(value.mimeType))throw new AppError('SUBJECT_ASSET_UNSUPPORTED','主体版本需要托管 PNG、JPEG 或 WebP 图片',400);
  if(!/^[a-f0-9]{64}$/.test(value.sha256??'')||![value.width,value.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=100000)||!['user-import','generated','synthetic-mock','export'].includes(value.provenance))invalid();
  const sources=db.prepare(`SELECT ${columns('id')} FROM versions WHERE ${INSPECTION_VERSION_ASSET_EXPRESSION}=? ORDER BY id LIMIT 2`).all(id);
  if(sources.length>1)invalid();
  let source=null;if(sources.length){try{source=graph.version(sources[0].id,undefined,id);}catch{invalid();}}
  let imageSource;try{imageSource=graph.imageSource(id);}catch{invalid();}
  return {assetId:value.id,sha256:value.sha256,mimeType:value.mimeType,width:value.width,height:value.height,provenance:{kind:value.provenance,versionId:source?.id??null,shotId:source?.shotId??null,jobId:source?.jobId??null,...(imageSource?{imageSource}:{})}};
 }
 function subjectRow(id){
  if(subjects.has(id))return subjects.get(id);
  const row=db.prepare(`SELECT ${subjectColumns} FROM subjects WHERE id=? AND projectId=?`).get(id,projectId);if(!row)missing();
  if(!uuid(row.id)||row.id!==id||row.projectId!==projectId||!uuid(row.headVersionId)||!Number.isSafeInteger(row.revision)||row.revision<1)invalid();
  subjects.set(id,row);return row;
 }
 function version(id,subjectId){
  if(versions.has(id)){const saved=versions.get(id);if(subjectId&&saved.subjectId!==subjectId)missing();return saved;}
  const row=db.prepare(`SELECT ${versionColumns} FROM subject_versions WHERE id=? AND projectId=?`).get(id,projectId);if(!row)missing();
  if(subjectId&&row.subjectId!==subjectId)missing();const owner=subjectRow(row.subjectId);
  const value=decode(row.data);
  if(!isSubjectVersionResponse(value)||value.id!==row.id||value.projectId!==row.projectId||value.subjectId!==row.subjectId||value.number!==row.number||value.assetId!==row.assetId||value.number>owner.revision)invalid();
  const frozen=asset(value.assetId);
  if(!equal(frozen,{assetId:value.assetId,sha256:value.sha256,mimeType:value.mimeType,width:value.width,height:value.height,provenance:value.provenance}))invalid();
  versions.set(id,value);return value;
 }
 function subject(id){
  const row=subjectRow(id),value={...row,headVersion:version(row.headVersionId,id)};
  if(!isSubjectResponse(value))invalid();return value;
 }
 function bindingRow(row){
  if(!row)return null;
  if(row.projectId!==projectId)missing();
  shot(row.shotId);const owner=subject(row.subjectId);
  if((owner.kind==='look'?'style':'subject')!==row.role)invalid();
  if(row.subjectVersionId!==null)version(row.subjectVersionId,owner.id);
  const reviewed=version(row.reviewedHeadVersionId,owner.id);if(reviewed.number>owner.revision)invalid();
  const value={...row,headVersionId:owner.headVersionId,subjectRevision:owner.revision,needsReview:row.subjectVersionId!==null&&row.reviewedHeadVersionId!==owner.headVersionId};
  if(!isSubjectBindingResponse(value))invalid();return value;
 }
 function binding(id){return bindingRow(db.prepare(`SELECT ${bindingColumns} FROM subject_bindings WHERE id=? AND projectId=?`).get(id,projectId));}
 function currentBinding(){return bindingRow(db.prepare(`SELECT ${bindingColumns} FROM subject_bindings WHERE shotId=? AND subjectId=? AND role=?`).get(input.shotId,input.subjectId,input.role));}
 function context(operation){
  project();
  if(operation==='subject.create')return {projectId,asset:asset(input.assetId)};
  if(operation==='subject.version.add')return {projectId,subject:subject(input.subjectId),asset:asset(input.assetId)};
  if(operation==='subject.binding.set'){
   shot(input.shotId);const owner=subject(input.subjectId);
   if(input.subjectVersionId!==null)version(input.subjectVersionId,owner.id);
   return {projectId,subject:owner,current:currentBinding()};
  }
  throw new AppError('UNKNOWN_OPERATION','未知主体变更',404);
 }
 function replay(operation,response){
  context(operation);
  if(!isSubjectMutationResponse(operation,input,response))invalid();
  if(operation!=='subject.binding.set'){
   const current=subject(response.id),historical=version(response.headVersionId,response.id);
   if(current.revision<response.revision||current.kind!==response.kind||current.name!==response.name||current.createdAt!==response.createdAt||!equal(historical,response.headVersion)||response.updatedAt!==historical.createdAt||
     (current.revision===response.revision&&!equal(current,response)))invalid();
  }else{
   const current=binding(response.id),owner=subject(response.subjectId),head=version(response.headVersionId,owner.id),reviewed=version(response.reviewedHeadVersionId,owner.id);
   if(response.subjectVersionId!==null)version(response.subjectVersionId,owner.id);
   if(!current||current.shotId!==response.shotId||current.subjectId!==response.subjectId||current.role!==response.role||current.revision<response.revision||current.createdAt!==response.createdAt||head.number!==response.subjectRevision||reviewed.number>head.number||owner.revision<response.subjectRevision)invalid();
   if(current.revision===response.revision&&['subjectVersionId','reviewedHeadVersionId','updatedAt'].some(key=>current[key]!==response[key]))invalid();
  }
  return response;
 }
 return {context,replay,project,shot,asset,subject,version,binding,bindingRow};
}

export function createSubjectServices(store,{canonical,now}){
 const {db,tx}=store,mutate=createMutationReplay(store,{canonical}),secret=randomBytes(32);
 const sign=body=>createHmac('sha256',secret).update(body).digest('base64url');
 function cursor(input,operation,after){const body=Buffer.from(JSON.stringify([1,input.projectId,operation,input.subjectId??null,input.shotId??null,input.limit??20,after])).toString('base64url');return `${body}.${sign(body)}`;}
 function after(input,operation){
  if(input.cursor===undefined)return operation==='subject.version.list'?0:'';
  if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(input.cursor))badCursor();
  const [body,signature]=input.cursor.split('.');if(!timingSafeEqual(Buffer.from(signature),Buffer.from(sign(body))))badCursor();
  let value;try{value=JSON.parse(Buffer.from(body,'base64url').toString());}catch{badCursor();}
  if(!Array.isArray(value)||value.length!==7||!equal(value.slice(0,6),[1,input.projectId,operation,input.subjectId??null,input.shotId??null,input.limit??20])||(operation==='subject.version.list'?(!Number.isSafeInteger(value[6])||value[6]<1):!uuid(value[6])))badCursor();
  return value[6];
 }
 const read=(operation,input)=>{
  const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
  try{
   const boundary=createSubjectRecoveryBoundary(db,input);boundary.project();const start=after(input,operation),limit=input.limit??20;let rows,items;
   if(operation==='subject.list'){
    rows=db.prepare(`SELECT ${columns('id')} FROM subjects WHERE projectId=? AND id>? ORDER BY id LIMIT ?`).all(input.projectId,start,limit+1);
    items=rows.slice(0,limit).map(row=>boundary.subject(row.id));
   }else if(operation==='subject.version.list'){
    boundary.subject(input.subjectId);
    rows=db.prepare(`SELECT ${columns('id,number')} FROM subject_versions WHERE projectId=? AND subjectId=? AND number>? ORDER BY number LIMIT ?`).all(input.projectId,input.subjectId,start,limit+1);
    items=rows.slice(0,limit).map(row=>boundary.version(row.id,input.subjectId));
   }else{
    const filter=input.shotId?'shotId':'subjectId',filterId=input[filter];if(input.shotId)boundary.shot(filterId);else boundary.subject(filterId);
    rows=db.prepare(`SELECT ${bindingColumns} FROM subject_bindings WHERE projectId=? AND ${filter}=? AND id>? ORDER BY id LIMIT ?`).all(input.projectId,filterId,start,limit+1);
    items=rows.slice(0,limit).map(row=>boundary.bindingRow(row));
   }
   return {projectId:input.projectId,items,nextCursor:rows.length>limit?cursor(input,operation,operation==='subject.version.list'?items.at(-1).number:items.at(-1).id):null};
  }finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}
 };
 function write(operation,input){
  const boundary=createSubjectRecoveryBoundary(db,input);
  return mutate(operation,input,{
   resolve:()=>boundary.context(operation),
   apply:context=>{
    const timestamp=now();
    if(operation==='subject.create'||operation==='subject.version.add'){
     const creating=operation==='subject.create';
     if(!creating){conflict(context.subject,input.expectedRevision);advance(context.subject.revision);if(context.subject.headVersion.assetId===input.assetId)throw new AppError('SUBJECT_NO_CHANGE','当前主体版本已使用此图片',409);}
     const id=creating?randomUUID():input.subjectId,revision=creating?1:context.subject.revision+1,versionId=randomUUID();
     const value={id:versionId,projectId:input.projectId,subjectId:id,number:revision,...context.asset,createdAt:timestamp};
     if(!isSubjectVersionResponse(value))invalid();
     if(creating)db.prepare('INSERT INTO subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)').run(id,input.projectId,input.kind,input.name,revision,versionId,timestamp,timestamp);
     db.prepare('INSERT INTO subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)').run(versionId,input.projectId,id,revision,input.assetId,JSON.stringify(value));
     if(!creating){const saved=db.prepare('UPDATE subjects SET revision=?,headVersionId=?,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(revision,versionId,timestamp,id,input.projectId,input.expectedRevision);if(saved.changes!==1)invalid();}
     return createSubjectRecoveryBoundary(db,input).subject(id);
    }
    const owner=context.subject,current=context.current,revision=current?.revision??0;
    conflict(owner,input.expectedSubjectRevision);conflict(current??{id:input.subjectId,revision:0},input.expectedRevision);advance(revision);
    if(input.role!==(owner.kind==='look'?'style':'subject'))throw new AppError('SUBJECT_ROLE_MISMATCH','look 只能绑定为 style，其他主体类型只能绑定为 subject',409);
    if(input.subjectVersionId!==null&&(!current||current.subjectVersionId===null)){
     const count=db.prepare('SELECT 1 FROM subject_bindings WHERE shotId=? AND subjectVersionId IS NOT NULL LIMIT 8').all(input.shotId).length;
     if(count>=SUBJECT_LIMITS.bindingsPerShot)throw new AppError('SUBJECT_BINDING_LIMIT','每个镜头最多绑定 8 个主体或风格',409);
    }
    const id=current?.id??randomUUID();
    if(current){const saved=db.prepare('UPDATE subject_bindings SET revision=?,subjectVersionId=?,reviewedHeadVersionId=?,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(revision+1,input.subjectVersionId,owner.headVersionId,timestamp,id,input.projectId,revision);if(saved.changes!==1)invalid();}
    else db.prepare('INSERT INTO subject_bindings(id,projectId,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,input.projectId,input.shotId,input.subjectId,input.role,1,input.subjectVersionId,owner.headVersionId,timestamp,timestamp);
    return createSubjectRecoveryBoundary(db,input).binding(id);
   },
   replay:response=>boundary.replay(operation,response),
   verify:response=>createSubjectRecoveryBoundary(db,input).replay(operation,response),
  });
 }
 const handlers=Object.fromEntries(Object.keys(subjectSchemas).map(operation=>[operation,input=>operation.endsWith('.list')?read(operation,input):write(operation,input)]));
 return {handlers};
}
