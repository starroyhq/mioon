import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError,PREVIS_LIMITS,PREVIS_THUMBNAIL_CARD,canonicalPrevisValue,defaultPrevisScene,isPrevisNodeRecord,previsSchemas,publicValue} from '@mioon/contracts';
import type {PrevisNodeRecord,PrevisScene,PrevisThumbnailGetResponse,PrevisThumbnailSetResponse} from '@mioon/contracts';
import {refuseRestoredOperation} from './workspace-restore-policy.ts';
import {usesPrevisSchema} from './workspace-schema-dispatch.ts';
import {validateImageConsumption} from './image-consumption.ts';
import {ownsStoreLock} from './db.ts';

// Camera previs nodes (schema64). A node's scene is saved whole under scene
// revision CAS with an exact stable-key receipt. Autosave writes often, so only
// the newest four scene saves of a node keep receipts: a retry of an older save
// finds no receipt and fails the CAS, and is never applied twice. Thumbnails
// are a disposable cache: overwritten per slot, evicted oldest first.
type Row=Record<string, unknown>;
export interface PrevisStore {
 readonly db: DatabaseSync;
 put<T extends object>(table: string,value: T): T;
 tx<T>(callback: ()=>T): T;
}
interface CreateInput {projectId: string; label?: string; position: {x: number; y: number}; requestId: string}
interface SceneSetInput {projectId: string; nodeId: string; expectedSceneRevision: number; scene: PrevisScene; requestId: string}
interface ThumbnailSetInput {projectId: string; nodeId: string; slot: string; sceneRevision: number; dataBase64: string}
interface ThumbnailGetInput {projectId: string; nodeId: string; slots: string[]}
interface ReceiptRow {operation: unknown; projectId: unknown; nodeId: unknown; inputHash: unknown; response: unknown}
type PrevisOperation=keyof typeof previsSchemas;

const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp']);
const messages: Readonly<Record<string,string>>=Object.freeze({
 NOT_FOUND:'找不到记录',
 PREVIS_NODE_REQUIRED:'这个节点不是机位预演',
 INVALID_PREVIS_RECORD:'预演节点记录无法验证，请先检查项目',
 IDEMPOTENCY_CONFLICT:'同一请求 ID 已用于不同操作、项目或内容',
 REVISION_CONFLICT:'预演场景已有新版本，请重新读取后再修改',
 PREVIS_REVISION_LIMIT:'预演节点的修订号已达上限',
 PREVIS_EXPORT_INVALID:'关键帧导出必须是本项目的图片素材',
 PREVIS_CAPACITY:'预演节点或保存记录已达上限',
 PREVIS_THUMBNAIL_STALE:'缩略图不是按当前场景渲染的',
 PREVIS_THUMBNAIL_SLOT:'当前场景没有这个关键帧',
 PREVIS_THUMBNAIL_INVALID:'缩略图必须是长边不超过384像素、不超过64KB的JPEG',
 PREVIS_STATE_CONFLICT:'工作区当前不能保存预演',
});
const failure=(code: string,status=409,details?: unknown): AppError=>new AppError(code,messages[code]??messages.INVALID_PREVIS_RECORD!,status,details);
function invalid(): never {throw failure('INVALID_PREVIS_RECORD');}
const sha=(value: string): string=>createHash('sha256').update(value).digest('hex');
const inputHash=(operation: PrevisOperation,fields: Row): string=>sha(canonicalPrevisValue({operation,input:fields}));
const decode=(text: unknown): unknown=>{try{return JSON.parse(String(text));}catch{return invalid();}};
function parse<T>(operation: PrevisOperation,input: unknown): T {
 const parsed=previsSchemas[operation].safeParse(input);
 if(!parsed.success)throw new AppError('VALIDATION_ERROR','输入字段无效',400,{issues:parsed.error.issues.map(issue=>({path:issue.path,message:issue.message}))});
 return parsed.data as T;
}

// Baseline, extended sequential or progressive Huffman JPEG with one or three
// components, as a browser canvas encoder writes it. Only the container is read
// (ITU-T T.81 annex B): one frame header, an intact end, no pixel decoding.
const JPEG_FRAMES=new Set([0xc0,0xc1,0xc2]);
const JPEG_UNSUPPORTED_FRAMES=new Set([0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
export function previsJpegSize(bytes: Uint8Array): {width: number; height: number}|null {
 const view=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(view.length<4||view[0]!==0xff||view[1]!==0xd8||view[view.length-2]!==0xff||view[view.length-1]!==0xd9)return null;
 let offset=2,size: {width: number; height: number}|null=null;
 for(let segments=0;segments<1024;segments++){
  if(offset+4>view.length||view[offset]!==0xff)return null;
  while(view[offset]===0xff&&offset<view.length-1)offset++;
  const marker=view[offset++]!;
  if(marker===0xd8||marker===0xd9||marker===0x01||marker===0x00||(marker>=0xd0&&marker<=0xd7)||JPEG_UNSUPPORTED_FRAMES.has(marker)||offset+2>view.length)return null;
  const length=view.readUInt16BE(offset);
  if(length<2||offset+length>view.length)return null;
  if(JPEG_FRAMES.has(marker)){
   if(size||length<8||view[offset+2]!==8)return null;
   const height=view.readUInt16BE(offset+3),width=view.readUInt16BE(offset+5),components=view[offset+7]!;
   if(!height||!width||![1,3].includes(components)||length!==8+components*3)return null;
   size={width,height};
  }
  // Entropy-coded data follows the first scan header; the end marker was checked above.
  if(marker===0xda)return size;
  offset+=length;
 }
 return null;
}

/** Imported or duplicated previs nodes must be complete records whose
 * keyframe exports are image assets of their new project. */
export function validateImportedPrevisNode(db: DatabaseSync,value: unknown,projectId: string): void {
 if(!isPrevisNodeRecord(value)||value.projectId!==projectId)invalid();
 for(const assetId of value.scene.keyframes.flatMap(keyframe=>keyframe.exports))exportAsset(db,projectId,assetId);
}
function exportAsset(db: DatabaseSync,projectId: string,assetId: string): void {
 const reject=(): never=>{throw failure('PREVIS_EXPORT_INVALID',409,{assetId});};
 const row=db.prepare('SELECT projectId,data FROM assets WHERE id=?').get(assetId);
 if(!row||row.projectId!==projectId)reject();
 let asset: unknown;try{asset=JSON.parse(String(row!.data));}catch{reject();}
 const record=asset as Row|null;
 if(!record||typeof record!=='object'||record.id!==assetId||record.projectId!==projectId||!IMAGE_TYPES.has(String(record.mimeType)))reject();
 try{validateImageConsumption(db,record as {id: string; provenance?: unknown},projectId);}catch{reject();}
}

/** Read-only previs node and thumbnail access, shared with restored workspaces. */
export function createPrevisReaders(db: DatabaseSync) {
 function project(projectId: string): void {
  const row=db.prepare('SELECT data FROM projects WHERE id=?').get(projectId);
  if(!row)throw failure('NOT_FOUND',404,{id:projectId});
  if((decode(row.data) as Row|null)?.id!==projectId)invalid();
 }
 function node(projectId: string,nodeId: string): PrevisNodeRecord {
  project(projectId);
  const row=db.prepare(`SELECT projectId,CASE WHEN json_valid(data) THEN json_extract(data,'$.type') END AS type,
   CASE WHEN length(CAST(data AS BLOB))<=${PREVIS_LIMITS.nodeBytes} THEN data END AS data FROM nodes WHERE id=?`).get(nodeId);
  // A foreign node is reported exactly like a missing one.
  if(!row||row.projectId!==projectId)throw failure('NOT_FOUND',404,{id:nodeId});
  if(row.type!=='previs')throw failure('PREVIS_NODE_REQUIRED',409,{nodeId});
  if(typeof row.data!=='string')invalid();
  const value=decode(row.data);
  if(!isPrevisNodeRecord(value)||value.id!==nodeId||value.projectId!==projectId)invalid();
  return value;
 }
 function thumbnails(raw: unknown): PrevisThumbnailGetResponse {
  const input=parse<ThumbnailGetInput>('previs.thumbnail.get',raw);
  node(input.projectId,input.nodeId);
  // Workspaces before schema64 hold no thumbnails.
  if(!usesPrevisSchema(db))return {projectId:input.projectId,nodeId:input.nodeId,items:[]};
  const rows=db.prepare(`SELECT slot,sceneRevision,width,height,bytes,updatedAt FROM previs_thumbnails
   WHERE nodeId=? AND projectId=? AND slot IN (SELECT value FROM json_each(?))`).all(input.nodeId,input.projectId,JSON.stringify(input.slots));
  const bySlot=new Map(rows.map(row=>[row.slot,row]));
  const items=input.slots.filter(slot=>bySlot.has(slot)).map(slot=>{
   const row=bySlot.get(slot)!;
   if(!(row.bytes instanceof Uint8Array)||typeof row.sceneRevision!=='number'||typeof row.width!=='number'||typeof row.height!=='number'||typeof row.updatedAt!=='string')invalid();
   const bytes=Buffer.from(row.bytes as Uint8Array);
   return {slot,sceneRevision:row.sceneRevision as number,width:row.width as number,height:row.height as number,byteLength:bytes.length,updatedAt:row.updatedAt as string,dataBase64:bytes.toString('base64')};
  });
  return {projectId:input.projectId,nodeId:input.nodeId,items};
 }
 return {project,node,thumbnails};
}

export function createPrevisServices(store: PrevisStore,{now=()=>new Date().toISOString()}: {now?: ()=>string}={}) {
 const {db,put,tx}=store,readers=createPrevisReaders(db);
 function writable(operation: PrevisOperation,input: Row): void {
  refuseRestoredOperation(store,operation,input);
  if(!ownsStoreLock(store))throw failure('PREVIS_STATE_CONFLICT',403);
 }
 function receipt(requestId: string): ReceiptRow|undefined {
  return db.prepare(`SELECT operation,projectId,nodeId,inputHash,CASE WHEN length(CAST(response AS BLOB)) BETWEEN 1 AND ${PREVIS_LIMITS.responseBytes} THEN response END AS response
   FROM previs_requests WHERE requestId=?`).get(requestId) as ReceiptRow|undefined;
 }
 // An exact retry returns the node as that request left it, once the node is
 // confirmed to still be an owned previs node.
 function replay(prior: ReceiptRow,operation: PrevisOperation,projectId: string,hash: string,requestId: string,nodeId?: string): PrevisNodeRecord {
  if(prior.operation!==operation||prior.projectId!==projectId||prior.inputHash!==hash||(nodeId!==undefined&&prior.nodeId!==nodeId))
   throw failure('IDEMPOTENCY_CONFLICT',409,{requestId});
  if(typeof prior.response!=='string'||typeof prior.nodeId!=='string')invalid();
  const response=decode(prior.response);
  if(!isPrevisNodeRecord(response)||response.id!==prior.nodeId||response.projectId!==projectId)invalid();
  readers.node(projectId,prior.nodeId);
  return response;
 }
 function count(sql: string,...values: string[]): number {return Number(db.prepare(sql).get(...values)!.n);}
 function record(requestId: string,operation: PrevisOperation,value: PrevisNodeRecord,hash: string): PrevisNodeRecord {
  const serialized=JSON.stringify(publicValue(value));
  if(Buffer.byteLength(serialized)>PREVIS_LIMITS.responseBytes)throw failure('PREVIS_CAPACITY',507);
  db.prepare('INSERT INTO previs_requests(requestId,operation,projectId,nodeId,sceneRevision,inputHash,response) VALUES(?,?,?,?,?,?,?)')
   .run(requestId,operation,value.projectId,value.id,value.sceneRevision,hash,serialized);
  return JSON.parse(serialized) as PrevisNodeRecord;
 }
 function create(raw: unknown): PrevisNodeRecord {
  const input=parse<CreateInput>('previs.create',raw);
  writable('previs.create',input as unknown as Row);
  const {requestId,...fields}=input,hash=inputHash('previs.create',fields);
  return tx(()=>{
   readers.project(input.projectId);
   const prior=receipt(requestId);
   if(prior)return replay(prior,'previs.create',input.projectId,hash,requestId);
   if(count("SELECT count(*) AS n FROM previs_requests WHERE projectId=? AND operation='previs.create'",input.projectId)>=PREVIS_LIMITS.createsPerProject||
    count("SELECT count(*) AS n FROM previs_requests WHERE operation='previs.create'")>=PREVIS_LIMITS.createsGlobal||count('SELECT count(*) AS n FROM previs_requests')>=8192)
    throw failure('PREVIS_CAPACITY',507);
   const value: PrevisNodeRecord={id:randomUUID(),projectId:input.projectId,type:'previs',label:input.label??'',text:'',position:input.position,
    revision:1,sceneRevision:1,scene:defaultPrevisScene(),createdAt:now()};
   put('nodes',value);
   return record(requestId,'previs.create',value,hash);
  });
 }
 function setScene(raw: unknown): PrevisNodeRecord {
  const input=parse<SceneSetInput>('previs.scene.set',raw);
  writable('previs.scene.set',input as unknown as Row);
  const {requestId,...fields}=input,hash=inputHash('previs.scene.set',fields);
  return tx(()=>{
   // Ownership is checked before any retained receipt is used.
   const current=readers.node(input.projectId,input.nodeId);
   const prior=receipt(requestId);
   if(prior)return replay(prior,'previs.scene.set',input.projectId,hash,requestId,input.nodeId);
   if(current.sceneRevision!==input.expectedSceneRevision)throw failure('REVISION_CONFLICT',409,{entityId:current.id,
    expectedSceneRevision:input.expectedSceneRevision,currentSceneRevision:current.sceneRevision,current:publicValue(current)});
   if(current.revision>=Number.MAX_SAFE_INTEGER||current.sceneRevision>=Number.MAX_SAFE_INTEGER)throw failure('PREVIS_REVISION_LIMIT');
   // Earlier exports were checked when they were added.
   const known=new Set(current.scene.keyframes.flatMap(keyframe=>keyframe.exports));
   for(const assetId of input.scene.keyframes.flatMap(keyframe=>keyframe.exports))if(!known.has(assetId))exportAsset(db,input.projectId,assetId);
   const next: PrevisNodeRecord={...current,scene:input.scene,revision:current.revision+1,sceneRevision:current.sceneRevision+1};
   put('nodes',next);
   db.prepare("DELETE FROM previs_thumbnails WHERE nodeId=? AND slot!='card' AND slot NOT IN (SELECT value FROM json_each(?))")
    .run(current.id,JSON.stringify(input.scene.keyframes.map(keyframe=>keyframe.id)));
   // Keep the newest three earlier saves; this save becomes the fourth.
   db.prepare(`DELETE FROM previs_requests WHERE nodeId=? AND operation='previs.scene.set' AND (SELECT count(*) FROM previs_requests r
    WHERE r.nodeId=previs_requests.nodeId AND r.operation='previs.scene.set' AND r.sceneRevision>previs_requests.sceneRevision)>=${PREVIS_LIMITS.sceneReceiptsPerNode-1}`).run(current.id);
   if(count('SELECT count(*) AS n FROM previs_requests')>=8192)throw failure('PREVIS_CAPACITY',507);
   return record(requestId,'previs.scene.set',next,hash);
  });
 }
 function setThumbnail(raw: unknown): PrevisThumbnailSetResponse {
  const input=parse<ThumbnailSetInput>('previs.thumbnail.set',raw);
  writable('previs.thumbnail.set',input as unknown as Row);
  const bytes=Buffer.from(input.dataBase64,'base64'),size=bytes.toString('base64')===input.dataBase64&&bytes.length<=PREVIS_LIMITS.thumbnailBytes?previsJpegSize(bytes):null;
  if(!size||size.width>PREVIS_LIMITS.thumbnailEdge||size.height>PREVIS_LIMITS.thumbnailEdge)throw failure('PREVIS_THUMBNAIL_INVALID',400);
  return tx(()=>{
   const current=readers.node(input.projectId,input.nodeId);
   if(input.sceneRevision!==current.sceneRevision)throw failure('PREVIS_THUMBNAIL_STALE',409,{currentSceneRevision:current.sceneRevision});
   if(input.slot!==PREVIS_THUMBNAIL_CARD&&!current.scene.keyframes.some(keyframe=>keyframe.id===input.slot))throw failure('PREVIS_THUMBNAIL_SLOT',409,{slot:input.slot});
   const updatedAt=now(),values=[input.sceneRevision,size.width,size.height,bytes,updatedAt] as const;
   const updated=db.prepare('UPDATE previs_thumbnails SET sceneRevision=?,width=?,height=?,bytes=?,updatedAt=? WHERE nodeId=? AND slot=?').run(...values,input.nodeId,input.slot);
   if(!updated.changes){
    // Evict the least recently written thumbnails of the project, then of the workspace.
    const inProject=count('SELECT count(*) AS n FROM previs_thumbnails WHERE projectId=?',input.projectId);
    if(inProject>=PREVIS_LIMITS.thumbnailsPerProject)db.prepare('DELETE FROM previs_thumbnails WHERE rowid IN (SELECT rowid FROM previs_thumbnails WHERE projectId=? ORDER BY updatedAt,rowid LIMIT ?)')
     .run(input.projectId,inProject-PREVIS_LIMITS.thumbnailsPerProject+1);
    const total=count('SELECT count(*) AS n FROM previs_thumbnails');
    if(total>=PREVIS_LIMITS.thumbnailsGlobal)db.prepare('DELETE FROM previs_thumbnails WHERE rowid IN (SELECT rowid FROM previs_thumbnails ORDER BY updatedAt,rowid LIMIT ?)')
     .run(total-PREVIS_LIMITS.thumbnailsGlobal+1);
    db.prepare('INSERT INTO previs_thumbnails(nodeId,slot,projectId,sceneRevision,width,height,bytes,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
     .run(input.nodeId,input.slot,input.projectId,...values);
   }
   return {projectId:input.projectId,nodeId:input.nodeId,slot:input.slot,sceneRevision:input.sceneRevision,width:size.width,height:size.height,byteLength:bytes.length,updatedAt};
  });
 }
 const handlers: Record<string,(input: never)=>unknown>={
  'previs.create':(input: never)=>create(input),
  'previs.scene.set':(input: never)=>setScene(input),
  'previs.thumbnail.set':(input: never)=>setThumbnail(input),
  'previs.thumbnail.get':(input: never)=>readers.thumbnails(input),
 };
 return {handlers};
}
