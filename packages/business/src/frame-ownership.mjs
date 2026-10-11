import {createHash} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {canonicalFrameInput as canonical,FRAME_LIMITS,frameSchemas,frameSnapshotSchema,frameReceiptSchema,frameTaskResponseSchema} from '../../contracts/src/frame-extraction.mjs';
import {INSPECTION_ROW_LIMITS} from './inspection-query.mjs';

export const FRAME_OWNERSHIP_LIMITS=Object.freeze({maxOwners:64,maxMetadataBytes:1024*1024,maxAncestors:16});
const unavailable=()=>{throw new AppError('INSPECTION_UNAVAILABLE','Inspection data is unavailable',404);};
const exhausted=()=>{throw new AppError('INSPECTION_BUDGET_EXCEEDED','Inspection budget exceeded',429);};
const text=(name,max,nullable=false)=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}) THEN ${name} ELSE 0 END AS ${name}`;
const taskColumns=['id','projectId'].map(name=>text(name,36)).concat(text('requestId',800),text('inputHash',64),text('input',FRAME_LIMITS.inputBytes),text('snapshot',FRAME_LIMITS.snapshotBytes),text('state',40),
 `CASE WHEN typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991 THEN revision ELSE 0 END AS revision`,
 `CASE WHEN typeof(started)='integer' AND started IN (0,1) THEN started ELSE -1 END AS started`,text('stagedReceipt',FRAME_LIMITS.receiptBytes,true),text('assetId',36,true),text('errorCode',80,true),text('createdAt',40),text('updatedAt',40)).join(',');
const requestColumns=['projectId','taskId'].map(name=>text(name,36)).concat(text('requestId',800),text('operation',40),text('inputHash',64),text('canonicalInput',FRAME_LIMITS.inputBytes),text('response',FRAME_LIMITS.responseBytes)).join(',');
const resultOf=receipt=>Object.fromEntries(['assetId','sha256','mimeType','width','height','byteLength'].map(key=>[key,receipt[key]]));

// This reader never creates work, heals rows or reads files. Its caller supplies
// the same read budget used for all legacy/image/frame ancestry in the graph.
export function createFrameOwnershipReader(db,projectId,{consume=()=>{},fail=unavailable}={}){
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('frame_tasks','frame_requests') LIMIT 2").all();
 const available=tables.length===2;
 if(!available&&(tables.length||db.prepare('SELECT 1 FROM schema_version WHERE version=20 LIMIT 1').get()))fail();
 const tasks=new Map(),assets=new Map();let metadataBytes=0,taskCount=0;
 const account=value=>{const raw=JSON.stringify(value);consume(raw);if((metadataBytes+=Buffer.byteLength(raw))>FRAME_OWNERSHIP_LIMITS.maxMetadataBytes)exhausted();};
 const decode=(value,schema)=>{if(typeof value!=='string')fail();let parsed;try{parsed=JSON.parse(value);}catch{fail();}if(schema){const result=schema.safeParse(parsed);if(!result.success)fail();return result.data;}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail();return parsed;};
 function assetRecord(assetId){
  if(assets.has(assetId))return assets.get(assetId);
  const row=db.prepare(`SELECT ${text('id',36)},${text('projectId',36)},${text('data',INSPECTION_ROW_LIMITS.assets)} FROM assets WHERE id=? LIMIT 1`).get(assetId);if(!row)fail();account(row);
  const asset=decode(row.data);
  if(row.id!==assetId||asset.id!==row.id||row.projectId!==projectId||asset.projectId!==projectId)fail();
  assets.set(assetId,asset);return asset;
 }
 function sourceAsset(snapshot){
  const frozen=snapshot.source,asset=assetRecord(frozen.assetId);
  // Size, duration, dimensions and audio flags are mutable probe metadata.
  // Historical ACKs depend on the frozen metadata and immutable file identity.
  if(asset.sha256!==frozen.sha256||asset.mimeType!==frozen.mimeType||asset.relativePath!==frozen.relativePath||!frozen.relativePath.startsWith('media/'))fail();
  return asset;
 }
 function outputAsset(row,receipt,asset){
  if(row.state!=='succeeded'||!receipt||!asset||asset.id!==row.assetId||asset.projectId!==projectId||asset.sha256!==receipt.sha256||asset.mimeType!==receipt.mimeType||asset.width!==receipt.width||asset.height!==receipt.height||asset.sizeBytes!==receipt.byteLength||asset.provenance!=='extracted-frame'||asset.relativePath!==`media/${asset.id}.png`)fail();
 }
 function task(taskId){
  if(tasks.has(taskId))return tasks.get(taskId);
  if(!available||!frameSchemas['frame.task.get'].safeParse({projectId,taskId}).success)fail();
  if(++taskCount>FRAME_OWNERSHIP_LIMITS.maxOwners)exhausted();
  const rows=db.prepare(`SELECT ${taskColumns} FROM frame_tasks WHERE id=? LIMIT 2`).all(taskId);if(rows.length!==1)fail();const row=rows[0];account(row);
  if(row.id!==taskId||row.projectId!==projectId||![0,1].includes(row.started))fail();
  const input=decode(row.input,frameSchemas['frame.extract']),snapshot=decode(row.snapshot,frameSnapshotSchema),receipt=row.stagedReceipt===null?null:decode(row.stagedReceipt,frameReceiptSchema);
  const exactInput=canonical(input),inputHash=createHash('sha256').update(exactInput).digest('hex');
  if(row.input!==exactInput||row.inputHash!==inputHash||input.projectId!==projectId||input.requestId!==row.requestId||snapshot.projectId!==projectId||snapshot.taskId!==taskId||
   snapshot.source.assetId!==input.sourceAssetId||snapshot.source.sha256!==input.sourceHash||snapshot.requested.sourceFrame!==input.sourceFrame)fail();
  if((row.state==='succeeded')!==(row.assetId!==null)||row.assetId!==null&&receipt?.assetId!==row.assetId||receipt&&!row.started||
   receipt&&!['persisting','succeeded','local_result_error','interrupted'].includes(row.state)||['persisting','succeeded','local_result_error'].includes(row.state)&&!receipt)fail();
  if(row.state==='running'&&row.revision!==2||row.state==='succeeded'&&row.revision<4||['persisting','local_result_error'].includes(row.state)&&row.revision<3||
   row.state!=='queued'&&row.revision<2||row.started&&['interrupted','failed'].includes(row.state)&&row.revision<3)fail();
  if(receipt&&(receipt.projectId!==projectId||receipt.taskId!==taskId||receipt.inputHash!==inputHash||receipt.sourceAssetId!==input.sourceAssetId||receipt.sourceHash!==input.sourceHash||
   receipt.sourceFrame!==input.sourceFrame||receipt.fps!==snapshot.requested.fps||receipt.profileId!==snapshot.profile.id||receipt.selectionRule!==snapshot.profile.selectionRule||receipt.probe.width!==snapshot.source.width||receipt.probe.height!==snapshot.source.height))fail();
  const dto={id:row.id,projectId,requestId:row.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,sourceFrame:input.sourceFrame,fps:snapshot.requested.fps,profileId:snapshot.profile.id,
   state:row.state,revision:row.revision,started:row.started===1,result:row.assetId===null?null:resultOf(receipt),errorCode:row.errorCode,createdAt:row.createdAt,updatedAt:row.updatedAt};
  if(!frameTaskResponseSchema.safeParse(dto).success||Date.parse(row.updatedAt)<Date.parse(row.createdAt)||row.state==='queued'&&row.updatedAt!==row.createdAt)fail();
  const requests=db.prepare(`SELECT ${requestColumns} FROM frame_requests WHERE requestId=? LIMIT 2`).all(row.requestId);if(requests.length!==1)fail();const request=requests[0];account(request);
  if(request.requestId!==row.requestId||request.projectId!==projectId||request.taskId!==taskId||request.operation!=='frame.extract'||request.inputHash!==inputHash||request.canonicalInput!==exactInput)fail();
  const ack=decode(request.response,frameTaskResponseSchema),expected={...dto,state:'queued',revision:1,started:false,result:null,errorCode:null,updatedAt:row.createdAt};
  if(canonical(ack)!==canonical(expected))fail();
  sourceAsset(snapshot);
  if(row.assetId!==null)outputAsset(row,receipt,assetRecord(row.assetId));
  const value={row,input,snapshot,receipt,dto};tasks.set(taskId,value);return value;
 }
 function owners(assetId){
  if(!frameSchemas['frame.task.get'].safeParse({projectId,taskId:assetId}).success)fail();
  if(!available)return [];
  // Both the published relation and the retained receipt count, even if one
  // was damaged, oversized or reassigned. Only bounded IDs leave SQLite.
  const rows=db.prepare(`SELECT ${text('id',36)} FROM frame_tasks WHERE assetId=? OR CASE WHEN json_valid(stagedReceipt) THEN json_extract(stagedReceipt,'$.assetId') END=? ORDER BY id LIMIT 2`).all(assetId,assetId);
  if(rows.length)account(rows);return rows;
 }
 function source(taskId,asset){
  const value=task(taskId),{row,receipt,snapshot}=value;
  outputAsset(row,receipt,asset);
  return {frameTaskId:taskId,sourceAssetId:receipt.sourceAssetId,sourceHash:receipt.sourceHash,sourceFrame:receipt.sourceFrame,fps:snapshot.requested.fps,profileId:snapshot.profile.id,selectionRule:snapshot.profile.selectionRule};
 }
 return {task,owners,source};
}
