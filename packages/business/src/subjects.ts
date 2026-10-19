import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {AppError,subjectSchemas,isSubjectResponse,isSubjectVersionResponse,isSubjectBindingResponse,isSubjectMutationResponse,SUBJECT_LIMITS} from '@mioon/contracts';
import {createMutationReplay} from './mutation-replay.ts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {OwnedMediaGraphReader} from './inspection.ts';

type SubjectRow = Record<string, unknown>;
type SubjectRecoveryInput = {
 [key: string]: unknown;
 projectId: string;requestId?: string;
 assetId?: string;subjectId?: string;shotId?: string;subjectVersionId?: string|null;role?: string;
 kind?: string;name?: string;expectedRevision?: number;expectedSubjectRevision?: number;
};
type SubjectActionInput = {
 [key: string]: unknown;
 projectId: string;requestId?: string;subjectId?: string;shotId?: string;limit?: number;cursor?: unknown;
 expectedRevision: number;expectedSubjectRevision: number;assetId?: string;
 subjectVersionId: string|null;role: string;kind: string;name: string;
};
interface SubjectStore {db: DatabaseSync;tx: <T>(callback: ()=>T)=>T}
interface SubjectServiceOptions {canonical: (value: unknown)=>string|undefined;now: ()=>string;readOnly?: boolean}

const missing: ()=>never=()=>{throw new AppError('NOT_FOUND','找不到记录',404);};
const invalid: ()=>never=()=>{throw new AppError('INVALID_SUBJECT_RECORD','主体或关联状态不一致，请先检查项目',409);};
const badCursor: ()=>never=()=>{throw new AppError('INVALID_CURSOR','主体分页游标无效或已过期',400);};
const uuid=(value: unknown): value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const decode=(text: unknown): SubjectRow=>{let value: unknown;try{value=JSON.parse(text as string);}catch{invalid();}if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as SubjectRow;};
const columns=(names: string): string=>names.split(',').map(name=>['revision','number'].includes(name)?`CASE WHEN typeof(${name})='integer' AND ${name} BETWEEN 1 AND 9007199254740991 THEN ${name} END AS ${name}`:`CASE WHEN length(CAST(${name} AS BLOB))<=${name==='name'?480:name==='data'?4096:64} THEN ${name} END AS ${name}`).join(',');
const bindingColumns=columns('id,projectId,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId,createdAt,updatedAt');
const equal=(a: unknown,b: unknown): boolean=>JSON.stringify(a)===JSON.stringify(b);
const conflict=(current: {revision: number;id: string},expectedRevision: number): void=>{if(current.revision!==expectedRevision)throw new AppError('REVISION_CONFLICT','主体或绑定已有新版本，请重新读取后再修改',409,{entityId:current.id,expectedRevision,currentRevision:current.revision,current});};
const advance=(revision: number): void=>{if(revision===Number.MAX_SAFE_INTEGER)throw new AppError('SUBJECT_REVISION_LIMIT','主体或绑定版本已达到安全上限',409);};

// The same bounded ownership boundary is used by live calls and durable-task
// recovery. A receipt never grants permission to return missing/foreign data.
export function createSubjectRecoveryBoundary(db: DatabaseSync,input: SubjectRecoveryInput){
 const projectId=input.projectId,subjects=new Map<string, SubjectRow>(),versions=new Map<string, SubjectRow>();let graph: OwnedMediaGraphReader|undefined;
 function legacy(table: string,id: unknown): SubjectRow{
  const row=db.prepare(`SELECT id${table==='projects'?'':',projectId'},CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${(INSPECTION_ROW_LIMITS as Record<string,number>)[table]} THEN data END AS data FROM ${table} WHERE id=?${table==='projects'?'':' AND projectId=?'}`).get(...(table==='projects'?[id as string]:[id as string,projectId])) as SubjectRow|undefined;
  if(!row)missing();
  const value=decode(row.data);
  if(table!=='projects'&&value.projectId!==projectId)missing();
  if(value.id!==row.id||(table==='projects'&&value.id!==projectId))invalid();
  return value;
 }
 function project(): SubjectRow{return legacy('projects',projectId);}
 function shot(id: unknown): SubjectRow{return legacy('shots',id);}
 function withGraph<T>(read: (graph: OwnedMediaGraphReader)=>T): T{
  try{graph??=createOwnedMediaGraphReader(db,projectId);return read(graph);}catch(error){if(['INSPECTION_BUDGET_EXCEEDED','SUBJECT_ASSET_UNSUPPORTED'].includes((error as {code?: string}).code as string))throw error;invalid();}
 }
 function asset(id: unknown): unknown{legacy('assets',id);return withGraph(read=>read.subjectAsset(id as string));}
 function subjectRow(id: unknown): SubjectRow{
  if(subjects.has(id as string))return subjects.get(id as string)!;
  if(!db.prepare('SELECT 1 FROM subjects WHERE id=? AND projectId=?').get(id as string,projectId))missing();
  const row=withGraph(read=>read.subjectOwner(id as string)) as SubjectRow;subjects.set(id as string,row);return row;
 }
 function version(id: unknown,subjectId?: unknown): SubjectRow{
  if(versions.has(id as string)){const saved=versions.get(id as string)!;if(subjectId&&saved.subjectId!==subjectId)missing();return saved;}
  const row=db.prepare(`SELECT ${columns('subjectId,assetId')} FROM subject_versions WHERE id=? AND projectId=?`).get(id as string,projectId) as SubjectRow|undefined;if(!row)missing();
  if(subjectId&&row.subjectId!==subjectId)missing();subjectRow(row.subjectId);legacy('assets',row.assetId);
  const value=withGraph(read=>read.subjectVersion(id as string,subjectId as string)) as SubjectRow;versions.set(id as string,value);return value;
 }
 function subject(id: unknown): SubjectRow{
  const row=subjectRow(id),value={...row,headVersion:version(row.headVersionId,id)};
  if(!isSubjectResponse(value))invalid();return value;
 }
 function bindingRow(row: unknown): SubjectRow|null{
  if(!row)return null;
  const record=row as SubjectRow;
  if(record.projectId!==projectId)missing();
  shot(record.shotId);const owner=subject(record.subjectId);
  if((owner.kind==='look'?'style':'subject')!==record.role)invalid();
  if(record.subjectVersionId!==null)version(record.subjectVersionId,owner.id);
  const reviewed=version(record.reviewedHeadVersionId,owner.id);if((reviewed.number as number)>(owner.revision as number))invalid();
  const value={...record,headVersionId:owner.headVersionId,subjectRevision:owner.revision,needsReview:record.subjectVersionId!==null&&record.reviewedHeadVersionId!==owner.headVersionId};
  if(!isSubjectBindingResponse(value))invalid();return value;
 }
 function binding(id: unknown): SubjectRow|null{return bindingRow(db.prepare(`SELECT ${bindingColumns} FROM subject_bindings WHERE id=? AND projectId=?`).get(id as string,projectId));}
 function currentBinding(): SubjectRow|null{return bindingRow(db.prepare(`SELECT ${bindingColumns} FROM subject_bindings WHERE shotId=? AND subjectId=? AND role=?`).get(input.shotId as string,input.subjectId as string,input.role as string));}
 function context(operation: string): Record<string,unknown>{
  project();
  if(operation==='subject.create')return {projectId,asset:asset(input.assetId)};
  if(operation==='subject.version.add')return {projectId,subject:subject(input.subjectId),asset:asset(input.assetId)};
  if(operation==='subject.binding.set'){
   shot(input.shotId);const owner=subject(input.subjectId);
   if(input.subjectVersionId!==null&&input.subjectVersionId!==undefined)version(input.subjectVersionId,owner.id);
   return {projectId,subject:owner,current:currentBinding()};
  }
  throw new AppError('UNKNOWN_OPERATION','未知主体变更',404);
 }
 function replay(operation: string,response: unknown): unknown{
  context(operation);
  if(!isSubjectMutationResponse(operation,input as never,response))invalid();
  if(operation!=='subject.binding.set'){
   const record=response as SubjectRow;
   const current=subject(record.id),historical=version(record.headVersionId,record.id);
   if((current.revision as number)<(record.revision as number)||current.kind!==record.kind||current.name!==record.name||current.createdAt!==record.createdAt||!equal(historical,record.headVersion)||record.updatedAt!==historical.createdAt||
     (current.revision===record.revision&&!equal(current,record)))invalid();
  }else{
   const record=response as SubjectRow;
   const current=binding(record.id),owner=subject(record.subjectId),head=version(record.headVersionId,owner.id),reviewed=version(record.reviewedHeadVersionId,owner.id);
   if(record.subjectVersionId!==null)version(record.subjectVersionId,owner.id);
   if(!current||current.shotId!==record.shotId||current.subjectId!==record.subjectId||current.role!==record.role||(current.revision as number)<(record.revision as number)||current.createdAt!==record.createdAt||head.number!==record.subjectRevision||(reviewed.number as number)>(head.number as number)||(owner.revision as number)<(record.subjectRevision as number))invalid();
   if(current.revision===record.revision&&['subjectVersionId','reviewedHeadVersionId','updatedAt'].some(key=>current[key]!==record[key]))invalid();
  }
  return response;
 }
 return {context,replay,project,shot,asset,subject,subjectRow,version,binding,bindingRow};
}

export function createSubjectServices(store: SubjectStore,{canonical,now,readOnly=false}: SubjectServiceOptions){
 const db=store.db,mutate=createMutationReplay(store as never,{canonical:canonical as (value: unknown)=>string,readOnly}),secret=randomBytes(32);
 const sign=(body: string): string=>createHmac('sha256',secret).update(body).digest('base64url');
 function cursor(input: SubjectActionInput,operation: string,after: unknown): string{const body=Buffer.from(JSON.stringify([1,input.projectId,operation,input.subjectId??null,input.shotId??null,input.limit??20,after])).toString('base64url');return `${body}.${sign(body)}`;}
 function after(input: SubjectActionInput,operation: string): unknown{
  if(input.cursor===undefined)return operation==='subject.version.list'?0:'';
  if(typeof input.cursor!=='string'||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(input.cursor))badCursor();
  const [body,signature]=input.cursor.split('.');if(!timingSafeEqual(Buffer.from(signature),Buffer.from(sign(body))))badCursor();
  let value;try{value=JSON.parse(Buffer.from(body,'base64url').toString());}catch{badCursor();}
  if(!Array.isArray(value)||value.length!==7||!equal(value.slice(0,6),[1,input.projectId,operation,input.subjectId??null,input.shotId??null,input.limit??20])||(operation==='subject.version.list'?(!Number.isSafeInteger(value[6])||value[6]<1):!uuid(value[6])))badCursor();
  return value[6];
 }
 const read=(operation: string,input: SubjectActionInput)=>{
  const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
  try{
   const boundary=createSubjectRecoveryBoundary(db,input);boundary.project();const start=after(input,operation),limit=(input.limit??20) as number;let rows: SubjectRow[],items: unknown[];
   if(operation==='subject.list'){
    rows=db.prepare(`SELECT ${columns('id')} FROM subjects WHERE projectId=? AND id>? ORDER BY id LIMIT ?`).all(input.projectId,start as string,limit+1) as SubjectRow[];
    items=rows.slice(0,limit).map(row=>boundary.subject(row.id));
   }else if(operation==='subject.version.list'){
    boundary.subjectRow(input.subjectId);
    rows=db.prepare(`SELECT ${columns('id,number')} FROM subject_versions WHERE projectId=? AND subjectId=? AND number>? ORDER BY number LIMIT ?`).all(input.projectId,input.subjectId as string,start as number,limit+1) as SubjectRow[];
    items=rows.slice(0,limit).map(row=>boundary.version(row.id,input.subjectId));
   }else{
    const filter=input.shotId?'shotId':'subjectId',filterId=input[filter];if(input.shotId)boundary.shot(filterId);else boundary.subject(filterId);
    rows=db.prepare(`SELECT ${bindingColumns} FROM subject_bindings WHERE projectId=? AND ${filter}=? AND id>? ORDER BY id LIMIT ?`).all(input.projectId,filterId as string,start as string,limit+1) as SubjectRow[];
    items=rows.slice(0,limit).map(row=>boundary.bindingRow(row));
   }
   return {projectId:input.projectId,items,nextCursor:rows.length>limit?cursor(input,operation,operation==='subject.version.list'?(items.at(-1) as SubjectRow).number:(items.at(-1) as SubjectRow).id):null};
  }finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}
 };
 function write(operation: string,input: SubjectActionInput): unknown{
  const boundary=createSubjectRecoveryBoundary(db,input);
  return mutate(operation,input,{
   resolve:()=>boundary.context(operation) as never,
   apply:(context: Record<string, unknown>)=>{
    const timestamp=now();
    if(operation==='subject.create'||operation==='subject.version.add'){
     const creating=operation==='subject.create';
     const subjectState=context.subject as SubjectRow;
     if(!creating){conflict(subjectState as {revision: number;id: string},input.expectedRevision);advance(subjectState.revision as number);if((subjectState.headVersion as SubjectRow).assetId===input.assetId)throw new AppError('SUBJECT_NO_CHANGE','当前主体版本已使用此图片',409);}
     const id=creating?randomUUID():input.subjectId as string,revision=creating?1:(subjectState.revision as number)+1,versionId=randomUUID();
     const value={id:versionId,projectId:input.projectId,subjectId:id,number:revision,...(context.asset as SubjectRow),createdAt:timestamp};
     if(!isSubjectVersionResponse(value))invalid();
     if(creating)db.prepare('INSERT INTO subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)').run(id,input.projectId,input.kind as string,input.name as string,revision,versionId,timestamp,timestamp);
     db.prepare('INSERT INTO subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)').run(versionId,input.projectId,id,revision,input.assetId as string,JSON.stringify(value));
     if(!creating){const saved=db.prepare('UPDATE subjects SET revision=?,headVersionId=?,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(revision,versionId,timestamp,id,input.projectId,input.expectedRevision);if(saved.changes!==1)invalid();}
     return createSubjectRecoveryBoundary(db,input).subject(id);
    }
    const owner=context.subject as SubjectRow,current=context.current as SubjectRow|null,revision=(current?.revision as number|undefined)??0;
    conflict(owner as {revision: number;id: string},input.expectedSubjectRevision);conflict((current??{id:input.subjectId as string,revision:0}) as {revision: number;id: string},input.expectedRevision);advance(revision);
    if(input.role!==(owner.kind==='look'?'style':'subject'))throw new AppError('SUBJECT_ROLE_MISMATCH','look 只能绑定为 style，其他主体类型只能绑定为 subject',409);
    if(input.subjectVersionId!==null&&(!current||current.subjectVersionId===null)){
     const count=db.prepare('SELECT 1 FROM subject_bindings WHERE shotId=? AND subjectVersionId IS NOT NULL LIMIT 8').all(input.shotId as string).length;
     if(count>=SUBJECT_LIMITS.bindingsPerShot)throw new AppError('SUBJECT_BINDING_LIMIT','每个镜头最多绑定 8 个主体或风格',409);
    }
    const id=(current?.id as string|undefined)??randomUUID();
    if(current){const saved=db.prepare('UPDATE subject_bindings SET revision=?,subjectVersionId=?,reviewedHeadVersionId=?,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(revision+1,input.subjectVersionId as string|null,owner.headVersionId as string,timestamp,id,input.projectId,revision);if(saved.changes!==1)invalid();}
    else db.prepare('INSERT INTO subject_bindings(id,projectId,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,input.projectId,input.shotId as string,input.subjectId as string,input.role,1,input.subjectVersionId as string|null,owner.headVersionId as string,timestamp,timestamp);
    return createSubjectRecoveryBoundary(db,input).binding(id);
   },
   replay:(response: unknown)=>boundary.replay(operation,response),
   verify:(response: unknown)=>createSubjectRecoveryBoundary(db,input).replay(operation,response),
  } as never);
 }
 const handlers: Record<string,(input: unknown)=>unknown>=Object.fromEntries(Object.keys(subjectSchemas).map((operation): [string,(input: unknown)=>unknown]=>[operation,(input: unknown)=>operation.endsWith('.list')?read(operation,input as SubjectActionInput):write(operation,input as SubjectActionInput)]));
 return {handlers};
}
