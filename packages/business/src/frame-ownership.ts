import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '@mioon/contracts';
import {canonicalFrameInput as canonical,FRAME_LIMITS,frameSchemas,frameSnapshotSchema,frameReceiptSchema,frameTaskResponseSchema} from '../../contracts/src/frame-extraction.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import type {FrameReceipt,FrameSourceSnapshot} from './frame-storage.ts';

export const FRAME_OWNERSHIP_LIMITS=Object.freeze({maxOwners:64,maxMetadataBytes:1024*1024,maxAncestors:16});
export interface FrameExtractInput {
 readonly projectId: string;
 readonly sourceAssetId: string;
 readonly sourceHash: string;
 readonly sourceFrame: number;
 readonly requestId: string;
 readonly [key: string]: unknown;
}
export interface FrameTaskSnapshot {
 readonly projectId: string;
 readonly taskId: string;
 readonly source: FrameSourceSnapshot;
 readonly requested: Readonly<{sourceFrame: number; fps: number; [key: string]: unknown}>;
 readonly profile: Readonly<{id: string; selectionRule: string; [key: string]: unknown}>;
 readonly [key: string]: unknown;
}
export interface FrameTaskRow {
 readonly id: string;
 readonly projectId: string;
 readonly requestId: string;
 readonly inputHash: string;
 readonly input: string;
 readonly snapshot: string;
 readonly state: string;
 readonly revision: number;
 readonly started: number;
 readonly stagedReceipt: string | null;
 readonly assetId: string | null;
 readonly errorCode: string | null;
 readonly createdAt: string;
 readonly updatedAt: string;
 readonly [key: string]: unknown;
}
export interface FrameTaskDto {
 readonly id: string;
 readonly projectId: string;
 readonly requestId: string;
 readonly sourceAssetId: string;
 readonly sourceHash: string;
 readonly sourceFrame: number;
 readonly fps: number;
 readonly profileId: string;
 readonly state: string;
 readonly revision: number;
 readonly started: boolean;
 readonly result: Record<string, unknown> | null;
 readonly errorCode: string | null;
 readonly createdAt: string;
 readonly updatedAt: string;
 readonly [key: string]: unknown;
}
export interface FrameTaskView {
 readonly row: FrameTaskRow;
 readonly input: FrameExtractInput;
 readonly snapshot: FrameTaskSnapshot;
 readonly receipt: FrameReceipt | null;
 readonly dto: FrameTaskDto;
}
export interface FrameSourceIdentity {
 readonly frameTaskId: string;
 readonly sourceAssetId: string;
 readonly sourceHash: string;
 readonly sourceFrame: number;
 readonly fps: number;
 readonly profileId: string;
 readonly selectionRule: string;
}
export interface FrameOwnershipReader {
 task(taskId: string): FrameTaskView;
 owners(assetId: string): unknown[];
 source(taskId: string,asset: Record<string, unknown> | null): FrameSourceIdentity;
}
type ZodLike<T>={safeParse(value: unknown): {success: true; data: T} | {success: false; error: unknown}};

function unavailable(): never {throw new AppError('INSPECTION_UNAVAILABLE','Inspection data is unavailable',404);}
function exhausted(): never {throw new AppError('INSPECTION_BUDGET_EXCEEDED','Inspection budget exceeded',429);}
const text=(name: string,max: number,nullable=false): string=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}) THEN ${name} ELSE 0 END AS ${name}`;
const taskColumns=['id','projectId'].map(name=>text(name,36)).concat(text('requestId',800),text('inputHash',64),text('input',FRAME_LIMITS.inputBytes),text('snapshot',FRAME_LIMITS.snapshotBytes),text('state',40),
 `CASE WHEN typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991 THEN revision ELSE 0 END AS revision`,
 `CASE WHEN typeof(started)='integer' AND started IN (0,1) THEN started ELSE -1 END AS started`,text('stagedReceipt',FRAME_LIMITS.receiptBytes,true),text('assetId',36,true),text('errorCode',80,true),text('createdAt',40),text('updatedAt',40)).join(',');
const requestColumns=['projectId','taskId'].map(name=>text(name,36)).concat(text('requestId',800),text('operation',40),text('inputHash',64),text('canonicalInput',FRAME_LIMITS.inputBytes),text('response',FRAME_LIMITS.responseBytes)).join(',');
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const resultOf=(receipt: FrameReceipt): Record<string, unknown>=>Object.fromEntries(['assetId','sha256','mimeType','width','height','byteLength'].map(key=>[key,(receipt as unknown as Record<string, unknown>)[key]]));

// This reader never creates work, heals rows or reads files. Its caller supplies
// the same read budget used for all legacy/image/frame ancestry in the graph.
export function createFrameOwnershipReader(db: DatabaseSync,projectId: string,{consume=(): void=>{},fail=unavailable}: {consume?: (value: unknown)=>void; fail?: ()=>never}={}): FrameOwnershipReader {
 const reject: ()=>never=fail;
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('frame_tasks','frame_requests') LIMIT 2").all();
 const available=tables.length===2;
 if(!available&&(tables.length||db.prepare('SELECT 1 FROM schema_version WHERE version=20 LIMIT 1').get()))reject();
 const tasks=new Map<string,FrameTaskView>(),assets=new Map<string,Record<string,unknown>>();let metadataBytes=0,taskCount=0;
 const account=(value: unknown): void=>{const raw=JSON.stringify(value);consume(raw);if((metadataBytes+=Buffer.byteLength(raw))>FRAME_OWNERSHIP_LIMITS.maxMetadataBytes)exhausted();};
 function decodeRecord(value: unknown): Record<string, unknown> {
  if(typeof value!=='string')reject();
  let parsed: unknown;try{parsed=JSON.parse(value);}catch{reject();}
  if(!isRecord(parsed))reject();
  return parsed;
 }
 function decodeWith<T>(schema: ZodLike<T>,value: unknown): T {
  const parsed=decodeRecord(value),result=schema.safeParse(parsed);
  if(!result.success)reject();
  return result.data;
 }
 function assetRecord(assetId: string): Record<string, unknown> {
  const cached=assets.get(assetId);if(cached)return cached;
  const row=db.prepare(`SELECT ${text('id',36)},${text('projectId',36)},${text('data',INSPECTION_ROW_LIMITS.assets)} FROM assets WHERE id=? LIMIT 1`).get(assetId);if(!row)reject();account(row);
  const asset=decodeRecord(row.data);
  if(row.id!==assetId||asset.id!==row.id||row.projectId!==projectId||asset.projectId!==projectId)reject();
  assets.set(assetId,asset);return asset;
 }
 function sourceAsset(snapshot: FrameTaskSnapshot): Record<string, unknown> {
  const frozen=snapshot.source,asset=assetRecord(frozen.assetId);
  // Size, duration, dimensions and audio flags are mutable probe metadata.
  // Historical ACKs depend on the frozen metadata and immutable file identity.
  if(asset.sha256!==frozen.sha256||asset.mimeType!==frozen.mimeType||asset.relativePath!==frozen.relativePath||!frozen.relativePath.startsWith('media/'))reject();
  return asset;
 }
 function outputAsset(row: FrameTaskRow,receipt: FrameReceipt|null,asset: Record<string,unknown>|undefined): void {
  if(row.state!=='succeeded'||!receipt||!asset||asset.id!==row.assetId||asset.projectId!==projectId||asset.sha256!==receipt.sha256||asset.mimeType!==receipt.mimeType||asset.width!==receipt.width||asset.height!==receipt.height||asset.sizeBytes!==receipt.byteLength||asset.provenance!=='extracted-frame'||asset.relativePath!==`media/${String(asset.id)}.png`)reject();
 }
 function task(taskId: string): FrameTaskView {
  const cached=tasks.get(taskId);if(cached)return cached;
  if(!available||!frameSchemas['frame.task.get'].safeParse({projectId,taskId}).success)reject();
  if(++taskCount>FRAME_OWNERSHIP_LIMITS.maxOwners)exhausted();
  const rows=db.prepare(`SELECT ${taskColumns} FROM frame_tasks WHERE id=? LIMIT 2`).all(taskId);if(rows.length!==1)reject();const raw=rows[0];if(!raw)reject();account(raw);
  if(raw.id!==taskId||raw.projectId!==projectId||typeof raw.started!=='number'||![0,1].includes(raw.started))reject();
  const row=raw as unknown as FrameTaskRow;
  const input=decodeWith<FrameExtractInput>(frameSchemas['frame.extract'],row.input),snapshot=decodeWith<FrameTaskSnapshot>(frameSnapshotSchema,row.snapshot),
   receipt=row.stagedReceipt===null?null:decodeWith<FrameReceipt>(frameReceiptSchema,row.stagedReceipt);
  const exactInput=canonical(input),inputHash=createHash('sha256').update(exactInput).digest('hex');
  if(row.input!==exactInput||row.inputHash!==inputHash||input.projectId!==projectId||input.requestId!==row.requestId||snapshot.projectId!==projectId||snapshot.taskId!==taskId||
   snapshot.source.assetId!==input.sourceAssetId||snapshot.source.sha256!==input.sourceHash||snapshot.requested.sourceFrame!==input.sourceFrame)reject();
  const receiptAssetId=receipt?receipt.assetId:null;
  if((row.state==='succeeded')!==(row.assetId!==null)||row.assetId!==null&&receiptAssetId!==row.assetId||receipt&&!row.started||
   receipt&&!['persisting','succeeded','local_result_error','interrupted'].includes(row.state)||['persisting','succeeded','local_result_error'].includes(row.state)&&!receipt)reject();
  if(row.state==='running'&&row.revision!==2||row.state==='succeeded'&&row.revision<4||['persisting','local_result_error'].includes(row.state)&&row.revision<3||
   row.state!=='queued'&&row.revision<2||row.started&&['interrupted','failed'].includes(row.state)&&row.revision<3)reject();
  if(receipt&&(receipt.projectId!==projectId||receipt.taskId!==taskId||receipt.inputHash!==inputHash||receipt.sourceAssetId!==input.sourceAssetId||receipt.sourceHash!==input.sourceHash||
   receipt.sourceFrame!==input.sourceFrame||receipt.fps!==snapshot.requested.fps||receipt.profileId!==snapshot.profile.id||receipt.selectionRule!==snapshot.profile.selectionRule||
   (receipt.probe as unknown as Record<string,unknown>).width!==snapshot.source.width||(receipt.probe as unknown as Record<string,unknown>).height!==snapshot.source.height))reject();
  const dto: FrameTaskDto={id:row.id,projectId,requestId:row.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,sourceFrame:input.sourceFrame,fps:snapshot.requested.fps,profileId:snapshot.profile.id,
   state:row.state,revision:row.revision,started:row.started===1,result:row.assetId===null||!receipt?null:resultOf(receipt),errorCode:row.errorCode,createdAt:row.createdAt,updatedAt:row.updatedAt};
  if(!frameTaskResponseSchema.safeParse(dto).success||Date.parse(row.updatedAt)<Date.parse(row.createdAt)||row.state==='queued'&&row.updatedAt!==row.createdAt)reject();
  const requests=db.prepare(`SELECT ${requestColumns} FROM frame_requests WHERE requestId=? LIMIT 2`).all(row.requestId);if(requests.length!==1)reject();const request=requests[0];if(!request)reject();account(request);
  if(request.requestId!==row.requestId||request.projectId!==projectId||request.taskId!==taskId||request.operation!=='frame.extract'||request.inputHash!==inputHash||request.canonicalInput!==exactInput)reject();
  const ack=decodeWith<FrameTaskDto>(frameTaskResponseSchema,request.response),expected: FrameTaskDto={...dto,state:'queued',revision:1,started:false,result:null,errorCode:null,updatedAt:row.createdAt};
  if(canonical(ack)!==canonical(expected))reject();
  sourceAsset(snapshot);
  if(row.assetId!==null)outputAsset(row,receipt,assetRecord(row.assetId));
  const value: FrameTaskView={row,input,snapshot,receipt,dto};tasks.set(taskId,value);return value;
 }
 function owners(assetId: string): unknown[] {
  if(!frameSchemas['frame.task.get'].safeParse({projectId,taskId:assetId}).success)reject();
  if(!available)return [];
  // Both the published relation and the retained receipt count, even if one
  // was damaged, oversized or reassigned. Only bounded IDs leave SQLite.
  const rows=db.prepare(`SELECT ${text('id',36)} FROM frame_tasks WHERE assetId=? OR CASE WHEN json_valid(stagedReceipt) THEN json_extract(stagedReceipt,'$.assetId') END=? ORDER BY id LIMIT 2`).all(assetId,assetId);
  if(rows.length)account(rows);return rows;
 }
 function source(taskId: string,asset: Record<string,unknown>|null): FrameSourceIdentity {
  const value=task(taskId),{row,receipt,snapshot}=value;
  outputAsset(row,receipt,asset??undefined);
  if(!receipt)reject();
  return {frameTaskId:taskId,sourceAssetId:receipt.sourceAssetId,sourceHash:receipt.sourceHash,sourceFrame:receipt.sourceFrame,fps:snapshot.requested.fps,profileId:snapshot.profile.id,selectionRule:snapshot.profile.selectionRule};
 }
 return {task,owners,source};
}
