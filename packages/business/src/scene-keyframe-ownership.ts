import {hasAssetReference} from './asset-reference-record.ts';
import {isPublishedProjectOutput} from './project-output-publication.ts';
import {sceneOutputResultSchema} from '../../contracts/src/project-output-sources.ts';
import {canonicalSceneInput as canonical,sceneSchemas,sceneShotsSnapshotSchema,legacyWorkspaceSceneShotsSnapshotSchema,sceneResultSchema,sceneSegmentBounds} from '../../contracts/src/scene-tasks.ts';
import {createHash} from 'node:crypto';
import {isProjectDatabase as isProjectLayout} from './project-file/held-files.ts';
import type {DatabaseSync} from 'node:sqlite';
import {AppError,SCENE_KEYFRAME_PROVENANCE,SCENE_LIMITS,sceneShotsReceiptSchema} from '@mioon/contracts';
import type {SceneKeyframe,SceneShotsReceipt,SceneResult} from '@mioon/contracts';

export interface SceneKeyframeSource {readonly sceneTaskId: string; readonly sourceAssetId: string; readonly sourceHash: string; readonly segment: number; readonly sourceFrame: number}
export interface SceneKeyframeOwnershipReader {
 owners(assetId: string): {id?: unknown}[];
 source(taskId: string,asset: Record<string, unknown>): SceneKeyframeSource;
 portableSource(asset: Record<string,unknown>): SceneKeyframeSource;
}
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function unavailable(): never {throw new AppError('INSPECTION_UNAVAILABLE','Inspection data is unavailable',404);}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Receipt keyframes are listed inside SQLite; only bounded task IDs leave it. */
export const SCENE_KEYFRAME_OWNER_SQL="SELECT CASE WHEN length(CAST(t.id AS BLOB))=36 THEN t.id END AS id FROM scene_tasks t,json_each(CASE WHEN t.kind='shots' AND json_valid(t.stagedReceipt) THEN t.stagedReceipt ELSE '{}' END,'$.keyframes') k WHERE json_extract(k.value,'$.assetId')=?";

/** A saved keyframe asset matches its receipt entry exactly. Asset rows are only
 * written with the task's success, so the owner must have succeeded (or been
 * undone afterwards, which keeps the images). */
export function sceneKeyframeAssetMatches(asset: Record<string, unknown>,keyframe: SceneKeyframe,projectId: string,receipt?: SceneShotsReceipt,requestId?: string,input?: unknown,segment?: readonly [number,number,number]): boolean {
 if(asset.id!==keyframe.assetId||asset.projectId!==projectId||asset.provenance!==SCENE_KEYFRAME_PROVENANCE||asset.mimeType!=='image/png'||
  asset.sha256!==keyframe.sha256||asset.width!==keyframe.width||asset.height!==keyframe.height||asset.sizeBytes!==keyframe.byteLength)return false;
 if(!hasAssetReference(asset))return asset.relativePath===`media/${keyframe.assetId}.png`;
 return Boolean(receipt&&requestId&&sceneOutputResultSchema.safeParse(asset.sceneResult).success&&canonical(asset.sceneResult)===canonical({requestId,input,segment,receipt:{...receipt,keyframes:[keyframe]}})&&createHash('sha256').update(canonical(input)).digest('hex')===receipt.inputHash&&isPublishedProjectOutput(asset,{projectId,assetId:keyframe.assetId,owner:{kind:'scene',id:receipt.taskId,inputHash:receipt.inputHash,...(requestId?{requestId}:{})},targetKind:'generated',sha256:keyframe.sha256,sizeBytes:keyframe.byteLength,mimeType:'image/png'}));
}

// Like the frame reader: no work, no repair, no file reads. The caller owns the
// shared read budget and validates the source video in the same graph.
export function createSceneKeyframeOwnershipReader(db: DatabaseSync,projectId: string,{consume=(): void=>{},fail=unavailable}: {consume?: (value: unknown)=>void; fail?: ()=>never}={}): SceneKeyframeOwnershipReader {
 const reject: ()=>never=fail;
 const available=isProjectLayout(db)||Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scene_tasks' LIMIT 1").get());
 if(!available&&db.prepare('SELECT 1 FROM schema_version WHERE version=58 LIMIT 1').get())reject();
 const receipts=new Map<string,SceneShotsReceipt>(),requestIds=new Map<string,string>(),inputs=new Map<string,unknown>(),segments=new Map<string,readonly [number,number,number][]>();
 function receipt(taskId: string): SceneShotsReceipt {
  const cached=receipts.get(taskId);if(cached)return cached;
  const rows=db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id END AS id,CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,CASE WHEN typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 1 AND 800 THEN requestId END AS requestId,kind,state,
   CASE WHEN typeof(input)='text' AND length(CAST(input AS BLOB)) BETWEEN 1 AND ${SCENE_LIMITS.inputBytes} THEN input END AS input,
   CASE WHEN typeof(snapshot)='text' AND length(CAST(snapshot AS BLOB)) BETWEEN 1 AND ${SCENE_LIMITS.snapshotBytes} THEN snapshot END AS snapshot,
   CASE WHEN typeof(stagedReceipt)='text' AND length(CAST(stagedReceipt AS BLOB)) BETWEEN 1 AND ${SCENE_LIMITS.receiptBytes} THEN stagedReceipt END AS stagedReceipt FROM scene_tasks WHERE id=? LIMIT 2`).all(taskId);
  if(rows.length!==1)reject();const row=rows[0]!;consume(JSON.stringify(row));
  if(row.id!==taskId||row.projectId!==projectId||row.kind!=='shots'||!['succeeded','undone'].includes(String(row.state))||typeof row.stagedReceipt!=='string'||typeof row.requestId!=='string'||typeof row.input!=='string'||typeof row.snapshot!=='string')reject();
  let value: unknown;try{value=JSON.parse(row.stagedReceipt);}catch{reject();}
  const parsed=sceneShotsReceiptSchema.safeParse(value);
  if(!parsed.success||parsed.data.taskId!==taskId||parsed.data.projectId!==projectId)reject();
  const saved=parsed.data as SceneShotsReceipt;
  let inputValue:unknown,snapshotValue:unknown;try{inputValue=JSON.parse(row.input);snapshotValue=JSON.parse(row.snapshot);}catch{reject();}
  const input=sceneSchemas['scene.shots.create'].safeParse(inputValue),snapshot=(isProjectLayout(db)?sceneShotsSnapshotSchema:sceneShotsSnapshotSchema.or(legacyWorkspaceSceneShotsSnapshotSchema)).safeParse(snapshotValue);
  if(!input.success||!snapshot.success||canonical(input.data)!==row.input||createHash('sha256').update(row.input).digest('hex')!==saved.inputHash||input.data.requestId!==row.requestId||input.data.projectId!==projectId||input.data.sourceAssetId!==saved.sourceAssetId||input.data.sourceHash!==saved.sourceHash||
   snapshot.data.taskId!==taskId||snapshot.data.projectId!==projectId||snapshot.data.source.assetId!==saved.sourceAssetId||snapshot.data.source.sha256!==saved.sourceHash||snapshot.data.source.width!==saved.probe.width||snapshot.data.source.height!==saved.probe.height)reject();
  receipts.set(taskId,saved);requestIds.set(taskId,row.requestId);inputs.set(taskId,input.data);segments.set(taskId,snapshot.data.segments);return saved;
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
  if(!keyframe||!sceneKeyframeAssetMatches(asset,keyframe,projectId,saved,requestIds.get(taskId),inputs.get(taskId),segments.get(taskId)?.find(entry=>entry[0]===keyframe.segment)))reject();
  return {sceneTaskId:taskId,sourceAssetId:saved.sourceAssetId,sourceHash:saved.sourceHash,segment:keyframe.segment,sourceFrame:keyframe.sourceFrame};
 }
 function portableSource(asset: Record<string,unknown>): SceneKeyframeSource {
  if(!isProjectLayout(db))reject();
  const parsed=sceneOutputResultSchema.safeParse(asset.sceneResult);if(!parsed.success)reject();
  const {requestId,receipt:saved}=parsed.data,keyframe=saved.keyframes[0]!;
  if(db.prepare('SELECT 1 FROM scene_tasks WHERE id=? LIMIT 1').get(saved.taskId)||db.prepare('SELECT 1 FROM scene_requests WHERE taskId=? OR requestId=? LIMIT 1').get(saved.taskId,requestId)||saved.projectId!==projectId||!sceneKeyframeAssetMatches(asset,keyframe,projectId,saved,requestId,parsed.data.input,parsed.data.segment))reject();
  consume(JSON.stringify(parsed.data));
  // The request hash binds the selected immutable cut result. Re-derive the
  // middle mark from that portable project result, so changing both a copied
  // segment tuple and its receipt frame cannot forge a different selection.
  const text=(name:string,max:number,nullable=false):string=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max} THEN ${name} END AS ${name}`;
  const columns=[...['id','projectId','assetId'].map(name=>text(name,36)),text('sourceHash',64),text('origin',20),text('taskId',36,true),text('basedOnResultId',36,true),text('requestId',800,true),text('profileId',50),
   "CASE WHEN typeof(fps)='integer' AND fps=30 THEN fps END AS fps",`CASE WHEN typeof(frameCount)='integer' AND frameCount BETWEEN 1 AND ${SCENE_LIMITS.frameCount} THEN frameCount END AS frameCount`,
   text('options',1024,true),text('cuts',SCENE_LIMITS.cutsBytes),text('createdAt',40)].join(',');
  const rows=db.prepare(`SELECT ${columns} FROM scene_results WHERE id=? LIMIT 2`).all(parsed.data.input.resultId);if(rows.length!==1)reject();
  const row=rows[0]!;consume(JSON.stringify(row));
  let cuts:unknown,options:unknown;try{cuts=JSON.parse(String(row.cuts));options=row.options===null?null:JSON.parse(String(row.options));}catch{reject();}
  const result=sceneResultSchema.safeParse({...row,cuts,options});if(!result.success||result.data.projectId!==projectId||result.data.assetId!==saved.sourceAssetId||result.data.sourceHash!==saved.sourceHash)reject();
  const portableResult=result.data as SceneResult,bounds=sceneSegmentBounds(portableResult.cuts.map(cut=>cut.frame),portableResult.frameCount,keyframe.segment);
  if(!bounds||canonical(parsed.data.segment)!==canonical([keyframe.segment,...bounds]))reject();
  return {sceneTaskId:saved.taskId,sourceAssetId:saved.sourceAssetId,sourceHash:saved.sourceHash,segment:keyframe.segment,sourceFrame:keyframe.sourceFrame};
 }
 return {owners,source,portableSource};
}
