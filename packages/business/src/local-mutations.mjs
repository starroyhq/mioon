import {randomUUID} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {createMutationReplay} from './mutation-replay.mjs';
import {validateImageConsumption} from './image-consumption.mjs';

// Local canvas mutations share the existing revision/reference guards. Relation
// reads also verify relational columns against JSON before a conflict can expose
// a current record or an old receipt can return its original response.
export function createLocalMutationServices(store,{check,canonical,now,references}) {
 const {db,get,list,put}=store;
 const mutate=createMutationReplay(store,{canonical});
 const invalid=()=>{throw new AppError('INVALID_MUTATION_RECORD','记录或关联状态不一致，请先检查项目',409);};
 const foreign=()=>{throw new AppError('CROSS_PROJECT_REFERENCE','记录或关联不属于此项目');};
 const tables=new Set(['projects','shots','nodes','assets','versions','jobs']);
 function owned(table,id,projectId) {
  if(!tables.has(table))throw new Error('Unsupported local mutation table');
  if(typeof id!=='string'||!id)invalid();
  const row=db.prepare(`SELECT id,${table==='projects'?'':'projectId,'}${table==='versions'?'jobId,':''}data FROM ${table} WHERE id=?`).get(id);
  if(!row)throw new AppError('NOT_FOUND','找不到记录',404,{id});
  // Check the relational owner before decoding any foreign record content.
  if(table!=='projects'&&projectId!==undefined&&row.projectId!==projectId)foreign();
  let value;try{value=JSON.parse(row.data);}catch{invalid();}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.id!==row.id)invalid();
  if(table!=='projects'&&(typeof value.projectId!=='string'||value.projectId!==row.projectId))invalid();
  if(table==='versions'&&value.jobId!==row.jobId)invalid();
  if(table==='assets')validateImageConsumption(db,value,projectId??value.projectId);
  return value;
 }
 function project(projectId) {return owned('projects',projectId);}
 function target(table,id) {
  const value=owned(table,id);project(value.projectId);
  return {projectId:value.projectId,value};
 }
 function assets(projectId,ids) {
  if(!Array.isArray(ids))invalid();
  for(const id of ids)owned('assets',id,projectId);
 }
 function lastFrame(projectId,id) {
  if(id===null)return;
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))invalid();
  const value=owned('assets',id,projectId);
  if(!['image/png','image/jpeg','image/webp'].includes(value.mimeType))throw new AppError('INVALID_REFERENCE_SOURCE','尾帧必须为已导入或生成的 PNG、JPEG 或 WebP 图片');
 }
 function version(shot,versionId) {
  let value;
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
 function shotRelations(shot) {
  assets(shot.projectId,shot.referenceAssetIds);
  if(Object.hasOwn(shot,'lastFrameAssetId'))lastFrame(shot.projectId,shot.lastFrameAssetId);
  if(shot.selectedVersionId!=null)version(shot,shot.selectedVersionId);
 }
 function nodeRelations(node) {
  if(node.assetId!==undefined&&node.assetId!==null)owned('assets',node.assetId,node.projectId);
  if(node.type!=='text'){
   if(!node.assetId)throw new AppError('ASSET_REQUIRED','图片/视频/音频节点需要素材');
   const asset=owned('assets',node.assetId,node.projectId);
   if(typeof asset.mimeType!=='string'||!asset.mimeType.startsWith(node.type+'/'))
    throw new AppError('INVALID_NODE_ASSET','节点类型与素材不一致');
  }
 }
 function replayRecord(table,response,{projectId}) {
  if(!response||typeof response!=='object'||Array.isArray(response))invalid();
  if(table==='projects'){
   if(response.id!==projectId)invalid();
   project(response.id);
  }else{
   if(response.projectId!==projectId)invalid();
   const current=owned(table,response.id,projectId);
   const relations=table==='shots'?shotRelations:nodeRelations;
   relations(current);relations(response);
  }
 }
 const touchProject=id=>{const p=project(id);put('projects',{...p,revision:p.revision+1,updatedAt:now()});};
 const updateShot=(input,projectScope)=>mutate('shot.update',input,{
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
  validate:({value})=>{shotRelations(value);if(input.patch.referenceAssetIds!==undefined)assets(value.projectId,input.patch.referenceAssetIds);if(Object.hasOwn(input.patch,'lastFrameAssetId'))lastFrame(value.projectId,input.patch.lastFrameAssetId);},
  apply:({value:shot})=>{
   check(shot,input.expectedRevision);references.guardManualUpdate(shot,input.patch.referenceAssetIds);
   return put('shots',{...shot,...input.patch,revision:shot.revision+1,updatedAt:now()});
  },
  replay:(response,context)=>{if(response.id!==input.shotId)invalid();replayRecord('shots',response,context);},
 });
 const handlers={
  'shot.create':input=>mutate('shot.create',input,{
   resolve:()=>({projectId:project(input.projectId).id}),
   validate:()=>{assets(input.projectId,input.referenceAssetIds||[]);if(Object.hasOwn(input,'lastFrameAssetId'))lastFrame(input.projectId,input.lastFrameAssetId);},
   apply:()=>{
    const shot={id:randomUUID(),projectId:input.projectId,title:input.title,prompt:input.prompt||'',referenceAssetIds:input.referenceAssetIds||[],...(Object.hasOwn(input,'lastFrameAssetId')?{lastFrameAssetId:input.lastFrameAssetId}:{}),aspectRatio:input.aspectRatio||'9:16',duration:input.duration||2,parameters:input.parameters||{},position:input.position||{x:80+list('shots',input.projectId).length*300,y:100},orderIndex:list('shots',input.projectId).length,revision:1,selectedVersionId:null,createdAt:now(),updatedAt:now()};
    put('shots',shot);touchProject(input.projectId);return shot;
   },
   replay:(response,context)=>replayRecord('shots',response,context),
  }),
  'shot.update':input=>updateShot(input),
  'shot.reorder':input=>mutate('shot.reorder',input,{
   resolve:()=>({projectId:project(input.projectId).id}),
   // Verify requested owners even on replay. Membership/order validation belongs
   // to the new edit only, so later additions do not invalidate an old response.
   validate:()=>{for(const id of input.shotIds)owned('shots',id,input.projectId);},
   apply:()=>{
    const p=project(input.projectId);check(p,input.expectedRevision);
    const shots=list('shots',p.id);
    if(input.shotIds.length!==shots.length||new Set(input.shotIds).size!==shots.length||shots.some(s=>!input.shotIds.includes(s.id)))
     throw new AppError('INVALID_ORDER','顺序必须包含全部镜头且不能重复');
    input.shotIds.forEach((id,orderIndex)=>{const shot=owned('shots',id,p.id);put('shots',{...shot,orderIndex});});
    touchProject(p.id);return get('projects',p.id);
   },
   replay:(response,context)=>replayRecord('projects',response,context),
  }),
  'node.create':input=>mutate('node.create',input,{
   resolve:()=>({projectId:project(input.projectId).id}),
   validate:()=>nodeRelations(input),
   apply:()=>{
    // requestId is control-plane data; never spread it into a canvas record.
    const {requestId,...fields}=input;
    return put('nodes',{id:randomUUID(),...fields,label:input.label||'',text:input.text||'',revision:1,createdAt:now()});
   },
   replay:(response,context)=>replayRecord('nodes',response,context),
  }),
  'node.update':input=>mutate('node.update',input,{
   resolve:()=>target('nodes',input.nodeId),
   validate:({value})=>nodeRelations(value),
   apply:({value})=>{check(value,input.expectedRevision);return put('nodes',{...value,...input.patch,revision:value.revision+1});},
   replay:(response,context)=>{if(response.id!==input.nodeId)invalid();replayRecord('nodes',response,context);},
  }),
  'version.select':input=>mutate('version.select',input,{
   resolve:()=>target('shots',input.shotId),
   validate:({value})=>{shotRelations(value);version(value,input.versionId);},
   apply:({value})=>{check(value,input.expectedRevision);return put('shots',{...value,selectedVersionId:input.versionId,revision:value.revision+1,updatedAt:now()});},
   replay:(response,context)=>{if(response.id!==input.shotId)invalid();replayRecord('shots',response,context);},
  }),
 };
 return {handlers,updateShotInProject:(projectId,input)=>updateShot(input,projectId)};
}
