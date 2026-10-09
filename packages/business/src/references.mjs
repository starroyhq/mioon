import {randomUUID} from 'node:crypto';
import {AppError} from '@video-workbench/contracts';

// A reference edge owns one existing managed image and one shot reference slot.
// It never evaluates a graph or copies prompts from other nodes. Keep the stable
// asset ID on the edge: node labels/positions may change without retargeting it.
export function createReferenceServices(store,{required,check,hash,now}) {
 const {db,list,put,tx}=store;
 const bindings=shot=>list('edges',shot.projectId).filter(edge=>edge.kind==='reference'&&edge.target===shot.id);
 const conflict=(code,message,details={})=>{throw new AppError(code,message,409,details);};
 function validateBinding(shot,edge) {
  if(edge.role!=='first_frame'||shot.referenceAssetIds.length!==1||shot.referenceAssetIds[0]!==edge.sourceAssetId)
   conflict('REFERENCE_STATE_CONFLICT','首帧连线与镜头参考选择不一致，请先检查最新状态',{edgeId:edge.id,shotId:shot.id});
 }
 function snapshot(shot) {
  const edges=bindings(shot);
  if(edges.length>1)conflict('REFERENCE_STATE_CONFLICT','镜头存在多个首帧连线，请先检查最新状态',{shotId:shot.id});
  return edges.map(edge=>{validateBinding(shot,edge);return {edgeId:edge.id,sourceNodeId:edge.source,sourceAssetId:edge.sourceAssetId,role:edge.role};});
 }
 function guardManualUpdate(shot,referenceAssetIds) {
  if(referenceAssetIds===undefined)return;
  const edges=bindings(shot);
  if(edges.length&&JSON.stringify(referenceAssetIds)!==JSON.stringify(shot.referenceAssetIds))
   conflict('REFERENCE_CONNECTED','此镜头的首帧由画布连线控制；请先断开首帧连线，再修改参考图',{shotId:shot.id,edgeIds:edges.map(edge=>edge.id)});
 }
 function mutation(operation,input,apply) {
  return tx(()=>{
   const requestHash=hash({operation,input});
   const previous=db.prepare('SELECT requestHash,response FROM reference_requests WHERE requestId=?').get(input.requestId);
   if(previous){
    if(previous.requestHash!==requestHash)conflict('IDEMPOTENCY_CONFLICT','同一参考连线请求 ID 已用于不同内容',{requestId:input.requestId});
    return JSON.parse(previous.response);
   }
   required('projects',input.projectId);
   const response=apply();
   db.prepare('INSERT INTO reference_requests(requestId,requestHash,response) VALUES(?,?,?)').run(input.requestId,requestHash,JSON.stringify(response));
   return response;
  });
 }
 const handlers={
  'reference.attach':input=>mutation('reference.attach',input,()=>{
   const source=required('nodes',input.sourceNodeId),shot=required('shots',input.targetShotId);
   if(source.projectId!==input.projectId||shot.projectId!==input.projectId)
    throw new AppError('CROSS_PROJECT_REFERENCE','首帧两端必须属于此项目');
   check(source,input.expectedSourceRevision);check(shot,input.expectedShotRevision);
   if(source.type!=='image'||!source.assetId)throw new AppError('INVALID_REFERENCE_SOURCE','首帧连线只接受已导入的托管图片节点');
   const asset=required('assets',source.assetId);
   if(asset.projectId!==input.projectId)throw new AppError('CROSS_PROJECT_REFERENCE','参考素材不属于此项目');
   if(!['image/png','image/jpeg','image/webp'].includes(asset.mimeType)||!asset.relativePath||!asset.sha256)
    throw new AppError('INVALID_REFERENCE_SOURCE','首帧必须为已导入的托管 PNG、JPEG 或 WebP 图片');
   const edges=bindings(shot);
   if(edges.length){
    if(edges.length===1&&edges[0].source===source.id&&edges[0].sourceAssetId===asset.id&&edges[0].role===input.role){validateBinding(shot,edges[0]);return {edge:edges[0],shot};}
    conflict('REFERENCE_CONNECTED','此镜头已有首帧连线；请先断开，再连接其他图片',{shotId:shot.id,edgeIds:edges.map(edge=>edge.id)});
   }
   if(shot.referenceAssetIds.length)conflict('REFERENCE_SELECTION_EXISTS','此镜头已有手选参考图；请明确清除并保存选择后，再连接首帧',{shotId:shot.id,referenceAssetIds:shot.referenceAssetIds});
   const edge={id:randomUUID(),projectId:input.projectId,source:source.id,target:shot.id,kind:'reference',role:input.role,sourceAssetId:asset.id,createdAt:now()};
   const updated={...shot,referenceAssetIds:[asset.id],revision:shot.revision+1,updatedAt:now()};
   put('edges',edge);put('shots',updated);
   return {edge,shot:updated};
  }),
  'reference.detach':input=>mutation('reference.detach',input,()=>{
   const edge=required('edges',input.edgeId);
   if(edge.projectId!==input.projectId)throw new AppError('CROSS_PROJECT_REFERENCE','参考连线不属于此项目');
   if(edge.kind!=='reference'||edge.role!=='first_frame')throw new AppError('INVALID_REFERENCE_EDGE','这不是首帧参考连线；视觉连线请使用 edge.delete');
   const shot=required('shots',edge.target);
   if(shot.projectId!==input.projectId)throw new AppError('CROSS_PROJECT_REFERENCE','目标镜头不属于此项目');
   check(shot,input.expectedShotRevision);validateBinding(shot,edge);
   if(bindings(shot).length!==1)conflict('REFERENCE_STATE_CONFLICT','镜头存在多个首帧连线，请先检查最新状态',{shotId:shot.id});
   const updated={...shot,referenceAssetIds:[],revision:shot.revision+1,updatedAt:now()};
   db.prepare('DELETE FROM edges WHERE id=?').run(edge.id);put('shots',updated);
   return {edge,shot:updated,detached:true};
  }),
 };
 return {handlers,guardManualUpdate,snapshot};
}
