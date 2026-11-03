import {validAssetLocator} from './asset-reference-record.ts';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {admitProjectAssetSource, registeredProjectStore, prepareProjectAssetFullHash} from './project-media-storage.ts';

/** Only this timeline's bounded dependency set is prepared. Pure history and
 * coherent-snapshot readers continue to perform SQLite reads only. */
export async function prepareTimelineReferenceHashes(store: {db: DatabaseSync; root: string}, projectId: string,
 {signal, beforeEffect, clipId, maxBytes = 512 * 1024 * 1024, totalBytes = 1024 * 1024 * 1024, onBytes, validateSelection}: {signal?: AbortSignal; beforeEffect?: () => void; clipId?: string; maxBytes?: number; totalBytes?: number; onBytes?: (bytes:number)=>void; validateSelection?:(timeline:Record<string,unknown>)=>void} = {}): Promise<{preparedBytes:number}> {
 const owner = registeredProjectStore(store.root);
 if (!owner) return {preparedBytes:0};
 if (owner.db !== store.db || owner.projectId !== projectId || store.db.isTransaction) throw new TypeError('Timeline reference preparation requires its exact owner outside a transaction');
 const row = store.db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 262144 THEN data END AS data FROM timelines WHERE projectId=? LIMIT 1").get(projectId);
 if (!row) return {preparedBytes:0};
 let value: unknown; try {value = typeof row.data === 'string' ? JSON.parse(row.data) : null;} catch {value = null;}
 if (!value || typeof value !== 'object' || !('projectId' in value) || value.projectId !== projectId || !('clips' in value) || !Array.isArray(value.clips) || value.clips.length > 100) throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '时间线素材不可用', 409);
 validateSelection?.(value as Record<string,unknown>);
 const ids = new Set<string>();
 for (const clip of value.clips) {
  if (!clip || typeof clip !== 'object' || typeof clip.id !== 'string' || typeof clip.assetId !== 'string') throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '时间线素材不可用', 409);
  if (clipId === undefined || clip.id === clipId) ids.add(clip.assetId);
 }
 let total = 0, preparedBytes = 0;
 for (const id of ids) {
  signal?.throwIfAborted(); beforeEffect?.();
  const asset = owner.get('assets', id) as {projectId?: unknown; sizeBytes?: unknown; sha256?:unknown; mimeType?:unknown} | undefined;
  if (!asset || asset.projectId !== projectId) throw new AppError('TIMELINE_SOURCE_UNAVAILABLE','时间线素材不可用',409);
  if(asset.sha256===null){
   if(typeof asset.sizeBytes!=='number'||!Number.isSafeInteger(asset.sizeBytes)||asset.sizeBytes<1||asset.sizeBytes>maxBytes||total+asset.sizeBytes>totalBytes)throw new AppError('PREFLIGHT_BUDGET','素材完整哈希超出本次检查预算',409);
   total+=asset.sizeBytes;
   if(asset.mimeType!=='video/mp4'&&asset.mimeType!=='video/webm')throw new AppError('TIMELINE_SOURCE_UNAVAILABLE','时间线素材不可用',409);
   await prepareProjectAssetFullHash(store.root, id, {signal, beforeEffect, maxBytes,onBytes:(bytes)=>{preparedBytes+=bytes;if(preparedBytes>totalBytes)throw new AppError('PREFLIGHT_BUDGET','素材完整哈希超出本次检查预算',409);onBytes?.(bytes);}});
  }else{
   await admitProjectAssetSource(store.root,id,{signal,beforeEffect});
  }
 }
 signal?.throwIfAborted(); beforeEffect?.();
 const current = store.db.prepare('SELECT data FROM timelines WHERE id=? AND projectId=?').get(row.id!, projectId);
 if (current?.data !== row.data) throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '检查期间时间线已有变化', 409);
 return {preparedBytes};
}


/** A bounded, SQLite-only branch decision. Invalid records are left to each
 * operation's existing validator, preserving its refusal/error precedence. */
export function hasSampledTimelineReferences(store:{db:DatabaseSync;root:string},projectId:string,clipId?:string):boolean {
 if(!registeredProjectStore(store.root))return false;
 const row=store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 262144 THEN data END AS data FROM timelines WHERE projectId=? LIMIT 1").get(projectId);
 let timeline:unknown;try{timeline=typeof row?.data==='string'?JSON.parse(row.data):null;}catch{return false;}
 if(!timeline||typeof timeline!=='object'||!('clips' in timeline)||!Array.isArray(timeline.clips)||timeline.clips.length>100)return false;
 for(const clip of timeline.clips){
  if(!clip||typeof clip!=='object'||typeof clip.id!=='string'||typeof clip.assetId!=='string'||clipId!==undefined&&clip.id!==clipId)continue;
  const source=store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM assets WHERE id=? AND projectId=?").get(clip.assetId,projectId);
  let asset:unknown;try{asset=typeof source?.data==='string'?JSON.parse(source.data):null;}catch{continue;}
  if(asset&&typeof asset==='object'&&'projectId' in asset&&asset.projectId===projectId&&'id' in asset&&asset.id===clip.assetId&&validAssetLocator(store.db,asset)&&'sha256' in asset&&asset.sha256===null&&'mimeType' in asset&&(asset.mimeType==='video/mp4'||asset.mimeType==='video/webm'))return true;
 }
 return false;
}
