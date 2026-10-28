import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError,isPrevisNodeRecord} from '@mioon/contracts';
import {createMutationReplay} from './mutation-replay.ts';
import {validateImageConsumption} from './image-consumption.ts';

type MutationRecord=Record<string, unknown>&{id: string; projectId?: string};
export interface ShotCreateInput {
 projectId: string; requestId?: string; title: string; prompt?: string;
 referenceAssetIds?: readonly string[]; lastFrameAssetId?: string|null;
 aspectRatio?: string; duration?: number; parameters?: Record<string, unknown>; position?: {x: number; y: number};
}
export interface ShotPatch { referenceAssetIds?: readonly string[]; lastFrameAssetId?: string|null; [key: string]: unknown }
export interface ShotUpdateInput { projectId?: string; shotId: string; expectedRevision: number; patch: ShotPatch; requestId?: string }
export interface ShotReorderInput { projectId: string; expectedRevision: number; shotIds: string[]; requestId?: string }
export interface NodeCreateInput { projectId: string; requestId?: string; type: string; label?: string; text?: string; assetId?: string; position?: {x: number; y: number}; [key: string]: unknown }
export interface NodeUpdateInput { nodeId: string; expectedRevision: number; patch: Record<string, unknown>; requestId?: string }
export interface VersionSelectInput { shotId: string; versionId: string; expectedRevision: number; requestId?: string }

export interface LocalMutationStore {
 readonly db: DatabaseSync;
 get(table: string,id: string): unknown;
 list(table: string,projectId?: string): unknown[];
 put<T extends object>(table: string,value: T): T;
 tx<T>(callback: () => T): T;
}
export interface LocalMutationReferences {
 guardManualUpdate(shot: unknown,referenceAssetIds: unknown): void;
}
export interface LocalMutationOptions {
 readonly check: (value: Record<string,unknown>,revision: unknown)=>void;
 readonly canonical: (value: unknown)=>string;
 readonly now: ()=>string;
 readonly references: LocalMutationReferences;
 readonly readOnly?: boolean;
}
export interface LocalMutationHandlers {
 [operation: string]: (input: never)=>unknown;
}

// Local canvas mutations share the existing revision/reference guards. Relation
// reads also verify relational columns against JSON before a conflict can expose
// a current record or an old receipt can return its original response.
export function createLocalMutationServices(store: LocalMutationStore,{check,canonical,now,references,readOnly=false}: LocalMutationOptions) {
 const {db,get,list,put}=store;
 const mutate=createMutationReplay(store,{canonical,readOnly});
 function invalid(): never {throw new AppError('INVALID_MUTATION_RECORD','记录或关联状态不一致，请先检查项目',409);}
 function foreign(): never {throw new AppError('CROSS_PROJECT_REFERENCE','记录或关联不属于此项目');}
 const tables=new Set(['projects','shots','nodes','assets','versions','jobs']);
 function owned(table: string,id: unknown,projectId?: unknown): MutationRecord {
  if(!tables.has(table))throw new Error('Unsupported local mutation table');
  if(typeof id!=='string'||!id)invalid();
  const row=db.prepare(`SELECT id,${table==='projects'?'':'projectId,'}${table==='versions'?'jobId,':''}data FROM ${table} WHERE id=?`).get(id);
  if(!row)throw new AppError('NOT_FOUND','找不到记录',404,{id});
  // Check the relational owner before decoding any foreign record content.
  if(table!=='projects'&&projectId!==undefined&&row.projectId!==projectId)foreign();
  let value: unknown;try{value=JSON.parse(String(row.data));}catch{invalid();}
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as MutationRecord).id!==row.id)invalid();
  const record=value as MutationRecord;
  if(table!=='projects'&&(typeof record.projectId!=='string'||record.projectId!==row.projectId))invalid();
  if(table==='versions'&&record.jobId!==row.jobId)invalid();
  if(table==='assets')validateImageConsumption(db,record,typeof projectId==='string'?projectId:typeof record.projectId==='string'?record.projectId:'');
  return record;
 }
 function project(projectId: string): MutationRecord {return owned('projects',projectId);}
 function target(table: string,id: string) {
  const value=owned(table,id);project(value.projectId as string);
  return {projectId:value.projectId as string,value};
 }
 function assets(projectId: string,ids: unknown) {
  if(!Array.isArray(ids))invalid();
  for(const id of ids)owned('assets',id,projectId);
 }
 function lastFrame(projectId: string,id: unknown) {
  if(id===null)return;
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))invalid();
  const value=owned('assets',id,projectId);
  if(!(typeof value.mimeType==='string'&&['image/png','image/jpeg','image/webp'].includes(value.mimeType)))throw new AppError('INVALID_REFERENCE_SOURCE','尾帧必须为已导入或生成的 PNG、JPEG 或 WebP 图片');
 }
 function version(shot: MutationRecord,versionId: string) {
  let value: MutationRecord;
  try{value=owned('versions',versionId,shot.projectId);}
  catch(error){
   // Preserve the legacy public error without decoding a foreign version row.
   if(error instanceof AppError&&error.code==='CROSS_PROJECT_REFERENCE')throw new AppError('INVALID_VERSION','版本不属于此镜头');
   throw error;
  }
  if(value.shotId!==shot.id)throw new AppError('INVALID_VERSION','版本不属于此镜头');
  owned('assets',value.assetId,shot.projectId);
  const job=owned('jobs',value.jobId,shot.projectId);
  if(job.shotId!==shot.id||(job.versionId!=null&&job.versionId!==value.id))invalid();
  return value;
 }
 function shotRelations(shot: MutationRecord) {
  assets(shot.projectId as string,shot.referenceAssetIds);
  if(Object.hasOwn(shot,'lastFrameAssetId'))lastFrame(shot.projectId as string,shot.lastFrameAssetId);
  if(shot.selectedVersionId!=null)version(shot,shot.selectedVersionId as string);
 }
 function nodeRelations(node: MutationRecord) {
  // A previs node has no asset; its whole record, scene included, must be valid.
  if(node.type==='previs'){if(!isPrevisNodeRecord(node))invalid();return;}
  if(node.assetId!==undefined&&node.assetId!==null)owned('assets',node.assetId,node.projectId);
  if(node.type!=='text'){
   if(!node.assetId)throw new AppError('ASSET_REQUIRED','图片/视频/音频节点需要素材');
   const asset=owned('assets',node.assetId,node.projectId);
   if(typeof asset.mimeType!=='string'||!asset.mimeType.startsWith(String(node.type)+'/'))
    throw new AppError('INVALID_NODE_ASSET','节点类型与素材不一致');
  }
 }
 function replayRecord(table: string,response: unknown,{projectId}: {projectId: string}) {
  if(!response||typeof response!=='object'||Array.isArray(response))invalid();
  const record=response as MutationRecord;
  if(table==='projects'){
   if(record.id!==projectId)invalid();
   project(record.id);
  }else{
   if(record.projectId!==projectId)invalid();
   const current=owned(table,record.id,projectId);
   const relations=table==='shots'?shotRelations:nodeRelations;
   relations(current);relations(record);
  }
 }
 const touchProject=(id: string): void=>{const p=project(id);put('projects',{...p,revision:(p.revision as number)+1,updatedAt:now()});};
 const updateShot=(input: ShotUpdateInput,projectScope?: string)=>mutate('shot.update',input,{
  resolve:()=>{
   if(projectScope===undefined)return target('shots',input.shotId);
   // The approved Agent project is checked after BEGIN IMMEDIATE, including
   // exact replay. A preflight read outside this transaction cannot bind scope
   // against a second writer that reassigns the target before the lock is held.
   try{project(projectScope);return {projectId:projectScope,value:owned('shots',input.shotId,projectScope)};}
   catch(error){
    if(error instanceof AppError&&['NOT_FOUND','CROSS_PROJECT_REFERENCE'].includes(error.code))
     throw new AppError('NOT_FOUND','找不到记录',404);
    throw error;
   }
  },
  validate:({value})=>{shotRelations(value);if(input.patch.referenceAssetIds!==undefined)assets(value.projectId as string,input.patch.referenceAssetIds);if(Object.hasOwn(input.patch,'lastFrameAssetId'))lastFrame(value.projectId as string,input.patch.lastFrameAssetId);},
  apply:({value:shot})=>{
   check(shot,input.expectedRevision);references.guardManualUpdate(shot,input.patch.referenceAssetIds);
   return put('shots',{...shot,...input.patch,revision:(shot.revision as number)+1,updatedAt:now()});
  },
  replay:(response,context)=>{if((response as MutationRecord).id!==input.shotId)invalid();replayRecord('shots',response,context);},
 });
 const handlers: Record<string,(input: never)=>unknown>={
  'shot.create':(input: ShotCreateInput)=>mutate('shot.create',input,{
   resolve:()=>({projectId:project(input.projectId).id}),
   validate:()=>{assets(input.projectId,input.referenceAssetIds||[]);if(Object.hasOwn(input,'lastFrameAssetId'))lastFrame(input.projectId,input.lastFrameAssetId);},
   apply:()=>{
    const shot={id:randomUUID(),projectId:input.projectId,title:input.title,prompt:input.prompt||'',referenceAssetIds:input.referenceAssetIds||[],...(Object.hasOwn(input,'lastFrameAssetId')?{lastFrameAssetId:input.lastFrameAssetId}:{}),aspectRatio:input.aspectRatio||'9:16',duration:input.duration||2,parameters:input.parameters||{},position:input.position||{x:80+list('shots',input.projectId).length*300,y:100},orderIndex:list('shots',input.projectId).length,revision:1,selectedVersionId:null,createdAt:now(),updatedAt:now()};
    put('shots',shot);touchProject(input.projectId);return shot;
   },
   replay:(response,context)=>replayRecord('shots',response,context),
  }),
  'shot.update':(input: ShotUpdateInput)=>updateShot(input),
  'shot.reorder':(input: ShotReorderInput)=>mutate('shot.reorder',input,{
   resolve:()=>({projectId:project(input.projectId).id}),
   // Verify requested owners even on replay. Membership/order validation belongs
   // to the new edit only, so later additions do not invalidate an old response.
   validate:()=>{for(const id of input.shotIds)owned('shots',id,input.projectId);},
   apply:()=>{
    const p=project(input.projectId);check(p,input.expectedRevision);
    const shots=list('shots',p.id);
    if(input.shotIds.length!==shots.length||new Set(input.shotIds).size!==shots.length||shots.some(s=>!input.shotIds.includes(typeof (s as MutationRecord).id==='string'?(s as MutationRecord).id as string:'')))
     throw new AppError('INVALID_ORDER','顺序必须包含全部镜头且不能重复');
    input.shotIds.forEach((id,orderIndex)=>{const shot=owned('shots',id,p.id);put('shots',{...shot,orderIndex});});
    touchProject(p.id);return get('projects',p.id);
   },
   replay:(response,context)=>replayRecord('projects',response,context),
  }),
  'node.create':(input: NodeCreateInput)=>mutate('node.create',input,{
   resolve:()=>({projectId:project(input.projectId).id}),
   validate:()=>nodeRelations(input as unknown as MutationRecord),
   apply:()=>{
    // requestId is control-plane data; never spread it into a canvas record.
    const {requestId: _requestId,...fields}=input;
    return put('nodes',{id:randomUUID(),...fields,label:input.label||'',text:input.text||'',revision:1,createdAt:now()});
   },
   replay:(response,context)=>replayRecord('nodes',response,context),
  }),
  'node.update':(input: NodeUpdateInput)=>mutate('node.update',input,{
   resolve:()=>target('nodes',input.nodeId),
   validate:({value})=>nodeRelations(value),
   apply:({value})=>{
    // A previs node's scene is saved by previs.scene.set; only its label and position change here.
    if(value.type==='previs'&&Object.hasOwn(input.patch,'text')&&input.patch.text!==value.text)throw new AppError('INVALID_NODE_PATCH','机位预演节点只能修改名称和位置',400,{nodeId:value.id});
    check(value,input.expectedRevision);return put('nodes',{...value,...input.patch,revision:(value.revision as number)+1});
   },
   replay:(response,context)=>{if((response as MutationRecord).id!==input.nodeId)invalid();replayRecord('nodes',response,context);},
  }),
  'version.select':(input: VersionSelectInput)=>mutate('version.select',input,{
   resolve:()=>target('shots',input.shotId),
   validate:({value})=>{shotRelations(value);version(value,input.versionId);},
   apply:({value})=>{check(value,input.expectedRevision);return put('shots',{...value,selectedVersionId:input.versionId,revision:(value.revision as number)+1,updatedAt:now()});},
   replay:(response,context)=>{if((response as MutationRecord).id!==input.shotId)invalid();replayRecord('shots',response,context);},
  }),
 };
 return {handlers,updateShotInProject:(projectId: string,input: ShotUpdateInput)=>updateShot(input,projectId)};
}
