import {AppError,isAssetDispositionResponse,isLocalMutationResponse} from '@mioon/contracts';
import {createMutationReplay} from './mutation-replay.mjs';
import {INSPECTION_ROW_LIMITS} from './inspection-query.mjs';

// Shared metadata belongs to the existing source asset. No asset or media write,
// timeline initialization, provider call, name change or deletion is involved.
export function createAssetDispositionServices(store,{canonical}) {
 const {db}=store,mutate=createMutationReplay(store,{canonical});
 const missing=()=>{throw new AppError('NOT_FOUND','找不到记录',404);};
 const invalid=()=>{throw new AppError('INVALID_ASSET_DISPOSITION_RECORD','素材标记或关联状态不一致，请先检查项目',409);};
 const decode=text=>{let value;try{value=JSON.parse(text);}catch{invalid();}if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value;};
 function readBatch({projectId,assetIds}) {
  // The request CTE bounds the work and preserves order without scanning the
  // project. One statement binds every owner and metadata row to one snapshot.
  // Check ALL relational owners before decoding any JSON or returning an item.
  const rows=db.prepare(`WITH requested(assetId,position) AS (VALUES ${assetIds.map((_,index)=>`(?,${index})`).join(',')})
   SELECT requested.assetId AS requestedAssetId,a.id,a.projectId,
    CASE WHEN length(CAST(a.data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.assets} THEN a.data END AS assetData,
    p.id AS projectIdFound,
    CASE WHEN length(CAST(p.data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.projects} THEN p.data END AS projectData,
    d.assetId AS dispositionAssetId,d.projectId AS dispositionProjectId,
    CASE WHEN typeof(d.revision)='integer' AND d.revision BETWEEN 1 AND 9007199254740991 THEN d.revision END AS revision,
    CASE WHEN length(CAST(d.disposition AS BLOB)) BETWEEN 1 AND 8 THEN d.disposition END AS disposition
   FROM requested LEFT JOIN assets a ON a.id=requested.assetId LEFT JOIN projects p ON p.id=?
    LEFT JOIN asset_dispositions d ON d.assetId=a.id ORDER BY requested.position`).all(...assetIds,projectId);
  if(rows.length!==assetIds.length||rows.some(row=>row.id!==row.requestedAssetId||row.projectId!==projectId||row.projectIdFound!==projectId))missing();
  const project=decode(rows[0].projectData);
  if(project.id!==projectId)invalid();
  const assets=rows.map(row=>decode(row.assetData));
  if(assets.some(asset=>asset.projectId!==projectId))missing();
  const items=rows.map((row,index)=>{
   if(assets[index].id!==row.id)invalid();
   if(row.dispositionAssetId!==null&&(row.dispositionProjectId!==projectId||!Number.isSafeInteger(row.revision)||row.revision<1))invalid();
   const response={id:row.id,assetId:row.id,projectId,revision:row.dispositionAssetId===null?0:row.revision,
    disposition:row.dispositionAssetId===null?'neutral':row.disposition};
   if(!isAssetDispositionResponse(response))invalid();
   return response;
  });
  return {projectId,items};
 }
 const read=input=>readBatch({projectId:input.projectId,assetIds:[input.assetId]}).items[0];
 function verifyResponse(input,response,current) {
  if(!isLocalMutationResponse('asset.disposition.set',input,response)||current.revision<response.revision||
     (current.revision===response.revision&&current.disposition!==response.disposition))invalid();
 }
 return {handlers:{
  'asset.disposition.list':readBatch,
  'asset.disposition.set':input=>mutate('asset.disposition.set',input,{
   resolve:()=>({projectId:input.projectId,current:read(input)}),
   apply:({current})=>{
    if(current.revision!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','素材标记已有新版本，请重新读取后再修改',409,
     {entityId:input.assetId,expectedRevision:input.expectedRevision,currentRevision:current.revision,current});
    if(current.revision===Number.MAX_SAFE_INTEGER)throw new AppError('DISPOSITION_REVISION_LIMIT','素材标记版本已达到安全上限',409);
    const revision=current.revision+1;
    const changed=current.revision===0?
     db.prepare('INSERT INTO asset_dispositions(assetId,projectId,revision,disposition) VALUES(?,?,?,?)').run(input.assetId,input.projectId,revision,input.disposition):
     db.prepare('UPDATE asset_dispositions SET revision=?,disposition=? WHERE assetId=? AND projectId=? AND revision=?')
      .run(revision,input.disposition,input.assetId,input.projectId,current.revision);
    if(changed.changes!==1)invalid();
    return {...current,revision,disposition:input.disposition};
   },
   replay:(response,{current})=>verifyResponse(input,response,current),
   verify:response=>verifyResponse(input,response,read(input)),
  }),
 }};
}
