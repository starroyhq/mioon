import {isAssetAnnotationResponse} from '../../contracts/src/asset-annotations.ts';
import type {DatabaseSync} from 'node:sqlite';

interface Runtime {
 mutate(operation:string,input:any,callbacks:any):any;
 error(code:string,message:string,status?:number,details?:object):Error;
 restoredSchema():number|null;
}
const ROW_BYTES=16384;
// User-authored project metadata only. Neither asset JSON nor media identity is changed.
export function createAssetAnnotationServices(store:{db:DatabaseSync},runtime:Runtime){
 const {db}=store,{mutate}=runtime;
 const missing=():never=>{throw runtime.error('NOT_FOUND','找不到记录',404);};
 const invalid=():never=>{throw runtime.error('INVALID_ASSET_ANNOTATION_RECORD','素材备注或关联状态不一致，请先检查项目',409);};
 const decode=(text:unknown):any=>{try{if(typeof text!=='string')return invalid();const value=JSON.parse(text);if(!value||typeof value!=='object')return invalid();return value;}catch{return invalid();}};
 function readBatch({projectId,assetIds}:any){
  // Only a positively verified frozen restoration predating annotations can lack this table.
  const restored=runtime.restoredSchema();
  const historical=restored!==null&&[25,27,29,31,33,35].includes(restored);
  const join=historical?'':`LEFT JOIN asset_annotations d ON d.assetId=a.id`;
  const columns=historical?'NULL AS annotationAssetId,NULL AS annotationProjectId,NULL AS revision,NULL AS tags,NULL AS note':
   `CASE WHEN typeof(d.assetId)='text' AND length(CAST(d.assetId AS BLOB))=36 THEN d.assetId END AS annotationAssetId,CASE WHEN typeof(d.projectId)='text' AND length(CAST(d.projectId AS BLOB))=36 THEN d.projectId END AS annotationProjectId,
    CASE WHEN typeof(d.revision)='integer' AND d.revision BETWEEN 1 AND 9007199254740991 THEN d.revision END AS revision,
    CASE WHEN typeof(d.tags)='text' AND length(CAST(d.tags AS BLOB)) BETWEEN 2 AND 16384 THEN d.tags END AS tags,
    CASE WHEN typeof(d.note)='text' AND length(CAST(d.note AS BLOB))<=16384 THEN d.note END AS note`;
  const rows=db.prepare(`WITH requested(assetId,position) AS (VALUES ${assetIds.map((_:unknown,index:number)=>`(?,${index})`).join(',')})
   SELECT requested.assetId AS requestedAssetId,CASE WHEN typeof(a.id)='text' AND length(CAST(a.id AS BLOB))=36 THEN a.id END AS id,CASE WHEN typeof(a.projectId)='text' AND length(CAST(a.projectId AS BLOB))=36 THEN a.projectId END AS projectId,
    CASE WHEN length(CAST(a.data AS BLOB)) BETWEEN 1 AND ${ROW_BYTES} THEN a.data END AS assetData,
    CASE WHEN typeof(p.id)='text' AND length(CAST(p.id AS BLOB))=36 THEN p.id END AS projectIdFound,CASE WHEN length(CAST(p.data AS BLOB)) BETWEEN 1 AND ${ROW_BYTES} THEN p.data END AS projectData,${columns}
   FROM requested LEFT JOIN assets a ON a.id=requested.assetId LEFT JOIN projects p ON p.id=? ${join} ORDER BY requested.position`).all(...assetIds,projectId);
  if(rows.length!==assetIds.length||rows.some((row:any)=>row.id!==row.requestedAssetId||row.projectId!==projectId||row.projectIdFound!==projectId))missing();
  if(decode(rows[0]!.projectData).id!==projectId)invalid();
  const assets=rows.map((row:any)=>decode(row.assetData));
  if(assets.some((asset:any)=>asset.projectId!==projectId))missing();
  const items=rows.map((row:any,index:number)=>{
   if(assets[index].id!==row.id)invalid();
   const absent=row.annotationAssetId===null;
   if(!absent&&(row.annotationProjectId!==projectId||!Number.isSafeInteger(row.revision)||row.revision<1))invalid();
   const value={id:row.id,assetId:row.id,projectId,revision:absent?0:row.revision,tags:absent?[]:decode(row.tags),note:absent?'':row.note};
   if(!isAssetAnnotationResponse(value))invalid();return value;
  });
  return {projectId,items};
 }
 const read=(input:any)=>readBatch({projectId:input.projectId,assetIds:[input.assetId]}).items[0];
 function verify(input:any,response:any,current:any){
  if((!isAssetAnnotationResponse(response)||response.assetId!==input.assetId||response.projectId!==input.projectId||response.revision!==input.expectedRevision+1||response.note!==input.note||JSON.stringify(response.tags)!==JSON.stringify(input.tags))||current.revision<response.revision||current.revision===response.revision&&(current.note!==response.note||JSON.stringify(current.tags)!==JSON.stringify(response.tags)))invalid();
 }
 return {handlers:{'asset.annotation.list':readBatch,'asset.annotation.set':(input:any)=>mutate('asset.annotation.set',input,{
  validate:undefined,
  resolve:()=>({projectId:input.projectId,current:read(input)}),
  apply:({current}:any)=>{
   if(current.revision!==input.expectedRevision)throw runtime.error('REVISION_CONFLICT','素材备注已有新版本，请重新读取后再修改',409,{entityId:input.assetId,expectedRevision:input.expectedRevision,currentRevision:current.revision,current});
   if(current.revision===Number.MAX_SAFE_INTEGER)throw runtime.error('ANNOTATION_REVISION_LIMIT','素材备注版本已达到安全上限',409);
   const revision=current.revision+1;
   const changed=current.revision===0?
    db.prepare('INSERT INTO asset_annotations(assetId,projectId,revision,tags,note) VALUES(?,?,?,?,?)').run(input.assetId,input.projectId,revision,JSON.stringify(input.tags),input.note):
    db.prepare('UPDATE asset_annotations SET revision=?,tags=?,note=? WHERE assetId=? AND projectId=? AND revision=?').run(revision,JSON.stringify(input.tags),input.note,input.assetId,input.projectId,current.revision);
   if(changed.changes!==1)invalid();return {...current,revision,tags:input.tags,note:input.note};
  },replay:(response:any,{current}:any)=>verify(input,response,current),verify:(response:any)=>verify(input,response,read(input)),
 })}};
}
