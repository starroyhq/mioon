import {AppError,isAssetDispositionResponse,isLocalMutationResponse} from '@mioon/contracts';
import {createMutationReplay} from './mutation-replay.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import type {DatabaseSync} from 'node:sqlite';
interface AssetDispositionStore {db: DatabaseSync}
interface AssetDispositionOptions {canonical: (value: unknown)=>string;readOnly?: boolean}
interface AssetDispositionCurrent {[key: string]: unknown;id: string;assetId: string;projectId: string;revision: number;disposition: string}
interface AssetDispositionSetInput {projectId: string;assetId: string;expectedRevision: number;requestId: string;disposition: string}
type AssetDispositionRow = Record<string, unknown>;

// Shared metadata belongs to the existing source asset. No asset or media write,
// timeline initialization, provider call, name change or deletion is involved.
export function createAssetDispositionServices(store: AssetDispositionStore,{canonical,readOnly=false}: AssetDispositionOptions) {
 const {db}=store,mutate=createMutationReplay(store as never,{canonical,readOnly});
 const missing: ()=>never=()=>{throw new AppError('NOT_FOUND','找不到记录',404);};
 const invalid: ()=>never=()=>{throw new AppError('INVALID_ASSET_DISPOSITION_RECORD','素材标记或关联状态不一致，请先检查项目',409);};
 const decode=(text: unknown): AssetDispositionRow=>{let value: unknown;try{value=JSON.parse(text as string);}catch{invalid();}if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as AssetDispositionRow;};
 function readBatch({projectId,assetIds}: {projectId: string;assetIds: string[]}): {projectId: string;items: unknown[]} {
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
  const items=rows.map((row: AssetDispositionRow,index: number)=>{
   if(assets[index].id!==row.id)invalid();
   if(row.dispositionAssetId!==null&&(row.dispositionProjectId!==projectId||!Number.isSafeInteger(row.revision)||(row.revision as number)<1))invalid();
   const response={id:row.id,assetId:row.id,projectId,revision:row.dispositionAssetId===null?0:row.revision,
    disposition:row.dispositionAssetId===null?'neutral':row.disposition};
   if(!isAssetDispositionResponse(response))invalid();
   return response;
  });
  return {projectId,items};
 }
 const read=(input: AssetDispositionSetInput): AssetDispositionCurrent=>readBatch({projectId:input.projectId,assetIds:[input.assetId]}).items[0] as AssetDispositionCurrent;
 function verifyResponse(input: AssetDispositionSetInput,response: unknown,current: AssetDispositionCurrent): void {
  const saved=response as AssetDispositionCurrent;
  if(!isLocalMutationResponse('asset.disposition.set',input as never,response)||current.revision<saved.revision||
     (current.revision===saved.revision&&current.disposition!==saved.disposition))invalid();
 }
 return {handlers:{
  'asset.disposition.list':readBatch,
  'asset.disposition.set':(input: AssetDispositionSetInput)=>mutate('asset.disposition.set',input,{
   resolve:()=>({projectId:input.projectId,current:read(input)}),
   apply:({current}: {current: AssetDispositionCurrent})=>{
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
   replay:(response: unknown,{current}: {current: AssetDispositionCurrent})=>verifyResponse(input,response,current),
   verify:(response: unknown)=>verifyResponse(input,response,read(input)),
  } as never),
 }};
}
