import type {DatabaseSync} from 'node:sqlite';
import {AppError,SCENE_KEYFRAME_PROVENANCE,SCENE_LIMITS,sceneShotsReceiptSchema} from '@mioon/contracts';
import type {SceneKeyframe,SceneShotsReceipt} from '@mioon/contracts';

export interface SceneKeyframeSource {readonly sceneTaskId: string; readonly sourceAssetId: string; readonly sourceHash: string; readonly segment: number; readonly sourceFrame: number}
export interface SceneKeyframeOwnershipReader {
 owners(assetId: string): {id?: unknown}[];
 source(taskId: string,asset: Record<string, unknown>): SceneKeyframeSource;
}
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function unavailable(): never {throw new AppError('INSPECTION_UNAVAILABLE','Inspection data is unavailable',404);}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Receipt keyframes are listed inside SQLite; only bounded task IDs leave it. */
export const SCENE_KEYFRAME_OWNER_SQL="SELECT CASE WHEN length(CAST(t.id AS BLOB))=36 THEN t.id END AS id FROM scene_tasks t,json_each(CASE WHEN t.kind='shots' AND json_valid(t.stagedReceipt) THEN t.stagedReceipt ELSE '{}' END,'$.keyframes') k WHERE json_extract(k.value,'$.assetId')=?";

/** A saved keyframe asset matches its receipt entry exactly. Asset rows are only
 * written with the task's success, so the owner must have succeeded (or been
 * undone afterwards, which keeps the images). */
export function sceneKeyframeAssetMatches(asset: Record<string, unknown>,keyframe: SceneKeyframe,projectId: string): boolean {
 return asset.id===keyframe.assetId&&asset.projectId===projectId&&asset.provenance===SCENE_KEYFRAME_PROVENANCE&&asset.mimeType==='image/png'&&
  asset.sha256===keyframe.sha256&&asset.width===keyframe.width&&asset.height===keyframe.height&&asset.sizeBytes===keyframe.byteLength&&
  asset.relativePath===`media/${keyframe.assetId}.png`;
}

// Like the frame reader: no work, no repair, no file reads. The caller owns the
// shared read budget and validates the source video in the same graph.
export function createSceneKeyframeOwnershipReader(db: DatabaseSync,projectId: string,{consume=(): void=>{},fail=unavailable}: {consume?: (value: unknown)=>void; fail?: ()=>never}={}): SceneKeyframeOwnershipReader {
 const reject: ()=>never=fail;
 const available=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scene_tasks' LIMIT 1").get());
 if(!available&&db.prepare('SELECT 1 FROM schema_version WHERE version=58 LIMIT 1').get())reject();
 const receipts=new Map<string,SceneShotsReceipt>();
 function receipt(taskId: string): SceneShotsReceipt {
  const cached=receipts.get(taskId);if(cached)return cached;
  const rows=db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id END AS id,CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,kind,state,
   CASE WHEN typeof(stagedReceipt)='text' AND length(CAST(stagedReceipt AS BLOB)) BETWEEN 1 AND ${SCENE_LIMITS.receiptBytes} THEN stagedReceipt END AS stagedReceipt FROM scene_tasks WHERE id=? LIMIT 2`).all(taskId);
  if(rows.length!==1)reject();const row=rows[0]!;consume(JSON.stringify(row));
  if(row.id!==taskId||row.projectId!==projectId||row.kind!=='shots'||!['succeeded','undone'].includes(String(row.state))||typeof row.stagedReceipt!=='string')reject();
  let value: unknown;try{value=JSON.parse(row.stagedReceipt);}catch{reject();}
  const parsed=sceneShotsReceiptSchema.safeParse(value);
  if(!parsed.success||parsed.data.taskId!==taskId||parsed.data.projectId!==projectId)reject();
  const saved=parsed.data as SceneShotsReceipt;receipts.set(taskId,saved);return saved;
 }
 function owners(assetId: string): {id?: unknown}[] {
  if(!uuid.test(assetId))reject();
  if(!available)return [];
  // Any receipt naming the asset is an owner, whatever its project or state;
  // source() then rejects a foreign or unfinished one.
  const rows=db.prepare(`${SCENE_KEYFRAME_OWNER_SQL} ORDER BY t.id LIMIT 2`).all(assetId);
  if(rows.length)consume(JSON.stringify(rows));return rows;
 }
 function source(taskId: string,asset: Record<string, unknown>): SceneKeyframeSource {
  if(!uuid.test(taskId)||!isRecord(asset))reject();
  const saved=receipt(taskId),keyframe=saved.keyframes.find(entry=>entry.assetId===asset.id);
  if(!keyframe||!sceneKeyframeAssetMatches(asset,keyframe,projectId))reject();
  return {sceneTaskId:taskId,sourceAssetId:saved.sourceAssetId,sourceHash:saved.sourceHash,segment:keyframe.segment,sourceFrame:keyframe.sourceFrame};
 }
 return {owners,source};
}
