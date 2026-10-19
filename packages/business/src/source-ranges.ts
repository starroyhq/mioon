import type {DatabaseSync} from 'node:sqlite';
import {AppError,SOURCE_RANGE_FPS,sourceFrameCount,isSourceRangeResponse,isLocalMutationResponse} from '@mioon/contracts';
import {createMutationReplay} from './mutation-replay.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';

interface SourceRangeStore {db: DatabaseSync}
interface SourceRangeRange {inFrame: number;outFrame: number}
interface SourceRangeResponse {id: string;assetId: string;projectId: string;revision: number;range: SourceRangeRange|null;sourceFrameCount: number;fps: number}
interface SourceRangeReadInput {projectId: string;assetId: string}
interface SourceRangeSetInput extends SourceRangeReadInput {requestId: string;expectedRevision: number;inFrame: number;outFrame: number}
interface SourceRangeMutationOptions {canonical: (value: unknown)=>string;readOnly?: boolean}

// The saved range belongs to the source asset, never to a generated version or
// timeline clip. Reading it does not materialize state or acquire a write lock.
export function createSourceRangeServices(store: SourceRangeStore,{canonical,readOnly=false}: SourceRangeMutationOptions) {
 const {db}=store,mutate=createMutationReplay(store as never,{canonical,readOnly});
 const missing: ()=>never=()=>{throw new AppError('NOT_FOUND','找不到记录',404);};
 const invalid: ()=>never=()=>{throw new AppError('INVALID_SOURCE_RANGE_RECORD','素材范围或关联状态不一致，请先检查项目',409);};
 const mediaTypes=new Set(['video/mp4','video/webm','audio/wav','audio/mpeg','audio/mp4']);
 const decode=<T>(text: unknown): T=>{let value;try{value=JSON.parse(text as string);}catch{invalid();}if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as T;};
 function read(input: SourceRangeReadInput): SourceRangeResponse {
  // One statement binds every owner and the mutable range to the same snapshot.
  // Check relational ownership before decoding any foreign JSON; errors never
  // contain a foreign record, saved response, asset name or filesystem path.
  const row=db.prepare(`SELECT a.id,a.projectId,
   CASE WHEN length(CAST(a.data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.assets} THEN a.data END AS assetData,
   p.id AS projectIdFound,
   CASE WHEN length(CAST(p.data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.projects} THEN p.data END AS projectData,
   r.assetId AS rangeAssetId,r.projectId AS rangeProjectId,r.revision,r.inFrame,r.outFrame
   FROM assets a LEFT JOIN projects p ON p.id=? LEFT JOIN asset_ranges r ON r.assetId=a.id WHERE a.id=?`).get(input.projectId,input.assetId);
  if(!row||row.projectId!==input.projectId||row.projectIdFound!==input.projectId)missing();
  const found=row as Record<string, unknown>;
  const project=decode<{id: string;projectId: string}>(found.projectData),asset=decode<{id: string;projectId: string;mimeType: string;duration: number|null}>(found.assetData);
  if(project.id!==input.projectId||asset.id!==input.assetId)invalid();
  if(asset.projectId!==input.projectId)missing();
  if(!mediaTypes.has(asset.mimeType))throw new AppError('SOURCE_RANGE_UNSUPPORTED','只有具有已知有效时长的视频或音频支持素材范围');
  const frames=sourceFrameCount(asset.duration);
  if(frames===null)throw new AppError('SOURCE_RANGE_UNSUPPORTED','只有具有已知有效时长的视频或音频支持素材范围');
  if(found.rangeAssetId!==null&&found.rangeProjectId!==input.projectId)invalid();
  const response: SourceRangeResponse={id:asset.id,assetId:asset.id,projectId:input.projectId,revision:found.rangeAssetId===null?0:found.revision as number,
   range:found.rangeAssetId===null?null:{inFrame:found.inFrame as number,outFrame:found.outFrame as number},sourceFrameCount:frames,fps:SOURCE_RANGE_FPS};
  if(!isSourceRangeResponse(response))invalid();
  return response;
 }
 function verifyResponse(input: SourceRangeSetInput,response: SourceRangeResponse,current: SourceRangeResponse): void {
  if(!isLocalMutationResponse('asset.range.set',input,response)||response.sourceFrameCount!==current.sourceFrameCount||
     current.revision<response.revision||(current.revision===response.revision&&
     (current.range?.inFrame!==response.range!.inFrame||current.range?.outFrame!==response.range!.outFrame)))invalid();
 }
 return {handlers:{
  'asset.range.get':read,
  'asset.range.set':(input: SourceRangeSetInput)=>mutate('asset.range.set',input,{
   resolve:()=>({projectId:input.projectId,current:read(input)}),
   validate: undefined,
   apply:({current}: {current: SourceRangeResponse})=>{
    if(current.revision!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','素材范围已有新版本，请重新读取后再修改',409,
     {entityId:input.assetId,expectedRevision:input.expectedRevision,currentRevision:current.revision,current});
    if(input.outFrame>current.sourceFrameCount)throw new AppError('SOURCE_BOUNDS','素材范围超出有效时长',400,{availableFrames:current.sourceFrameCount});
    if(current.revision===Number.MAX_SAFE_INTEGER)throw new AppError('RANGE_REVISION_LIMIT','素材范围版本已达到安全上限',409);
    const revision=current.revision+1;
    const changed=current.revision===0?
     db.prepare('INSERT INTO asset_ranges(assetId,projectId,revision,inFrame,outFrame) VALUES(?,?,?,?,?)').run(input.assetId,input.projectId,revision,input.inFrame,input.outFrame):
     db.prepare('UPDATE asset_ranges SET revision=?,inFrame=?,outFrame=? WHERE assetId=? AND projectId=? AND revision=?')
      .run(revision,input.inFrame,input.outFrame,input.assetId,input.projectId,current.revision);
    if((changed.changes as number)!==1)invalid();
    return {...current,revision,range:{inFrame:input.inFrame,outFrame:input.outFrame}};
   },
   replay:(response: unknown,{current}: {projectId: string;current: SourceRangeResponse})=>verifyResponse(input,response as SourceRangeResponse,current),
   verify:(response: unknown)=>verifyResponse(input,response as SourceRangeResponse,read(input)),
  } as never),
 }};
}
