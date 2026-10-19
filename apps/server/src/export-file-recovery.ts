import path from 'node:path';
import {constants} from 'node:fs';
import {open,link,unlink,lstat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {exportFileIdentitySchema} from '../../../packages/contracts/src/export-file-recovery.ts';
import type {ExportFileStatus} from '../../../packages/contracts/src/export-file-recovery.ts';
import {readTimelineExportOutput} from '../../../packages/business/src/timeline-delivery-read.ts';
import type {TimelineDeliveryReadGuards} from '../../../packages/business/src/timeline-delivery-read.ts';
interface Options{root:string;db:DatabaseSync;guards:TimelineDeliveryReadGuards;assertAvailable():void;validateFile(file:string,allowMissing:boolean):unknown;validateDirectory(directory:string):unknown;hold?:()=>()=>void;signal:AbortSignal}
const fail=(code='EXPORT_FILE_UNAVAILABLE',status=409)=>Object.assign(new Error('无法恢复导出文件。请选择与原记录完全一致的文件。'),{code,status});
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const parse=(value:unknown):unknown=>{try{return typeof value==='string'?JSON.parse(value):null;}catch{return null;}};
/** Recovery restores bytes only. Existing immutable export/asset records and
 * their snapshots are never updated, and no current timeline is initialized. */
export function createExportFileRecovery(options:Options){
 const active=new Set<string>();
 function identity(projectId:string,exportId:string):{file:string;digest:string;status:ExportFileStatus}{
  options.assertAvailable();options.signal.throwIfAborted();
  const timeline=readTimelineExportOutput(options.db,{projectId,exportId},options.guards);
  let asset:unknown=timeline?.asset,record:unknown=timeline?.record;
  if(!timeline){
   const row=options.db.prepare('SELECT data FROM exports WHERE id=? AND projectId=? AND length(CAST(data AS BLOB))<=4194304').get(exportId,projectId);
   record=object(row)?parse(row.data):null;
   if(!object(record)||record.mode==='timeline'||record.status!=='succeeded'||record.id!==exportId||record.projectId!==projectId||typeof record.requestId!=='string'||typeof record.assetId!=='string'||record.url!==`/media/${record.assetId}`||!Array.isArray(record.snapshot)||!Array.isArray(record.orderedVersionIds)||record.snapshot.length!==record.orderedVersionIds.length)throw fail();
   const receipt=options.db.prepare("SELECT resourceId FROM idempotency WHERE scope='export' AND requestId=?").get(record.requestId);
   if(!object(receipt)||receipt.resourceId!==exportId)throw fail();
   asset=options.guards.readOwnedAsset(projectId,record.assetId);
  }
  if(!object(asset)||!object(record)||typeof asset.id!=='string'||asset.projectId!==projectId||asset.id!==record.assetId||asset.mimeType!=='video/mp4'||asset.provenance!=='export'||typeof asset.relativePath!=='string'||
   !new RegExp(`^media/export-${exportId}-[a-f0-9-]{36}\\.mp4$`,'u').test(asset.relativePath)||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(asset.sha256)||typeof asset.sizeBytes!=='number'||!Number.isSafeInteger(asset.sizeBytes)||asset.sizeBytes<1||asset.sizeBytes>8*1024**3)throw fail();
  if(options.db.prepare("SELECT 1 FROM assets WHERE id<>? AND json_extract(data,'$.relativePath')=? LIMIT 1").get(asset.id,asset.relativePath))throw fail();
  const file=path.join(options.root,asset.relativePath),digest=createHash('sha256').update(JSON.stringify([timeline?.identityDigest??record,asset])).digest('hex');
  return {file,digest,status:{projectId,exportId,assetId:asset.id,sizeBytes:asset.sizeBytes,sha256:asset.sha256,status:'missing'} satisfies ExportFileStatus};
 }
 const exists=async(file:string)=>{options.validateFile(file,true);try{await lstat(file);return true;}catch(error){if(object(error)&&error.code==='ENOENT')return false;throw error;}};
 return {async handle(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
  if(url.pathname!=='/api/export-files')return false;
  if(req.method!=='GET'&&req.method!=='POST')throw fail('METHOD_NOT_ALLOWED',405);
  const keys=[...url.searchParams.keys()];if(keys.length!==2||new Set(keys).size!==2)throw fail('VALIDATION_ERROR',400);
  const input=exportFileIdentitySchema.safeParse(Object.fromEntries(url.searchParams));if(!input.success)throw fail('VALIDATION_ERROR',400);
  const initial=identity(input.data.projectId,input.data.exportId);initial.status.status=await exists(initial.file)?'present':'missing';
  if(req.method==='POST'&&initial.status.status==='missing'){
   if(active.has(input.data.exportId))throw fail('EXPORT_FILE_RECOVERY_BUSY');
   const length=req.headers['content-length'];if(length!==String(initial.status.sizeBytes))throw fail('EXPORT_FILE_SIZE_MISMATCH',400);
   const release=options.hold?.()??(()=>{});
   active.add(input.data.exportId);const part=path.join(options.root,'media',`.recover-${randomUUID()}.part`);let handle;
   try{
    options.validateDirectory(path.dirname(part));handle=await open(part,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const digest=createHash('sha256');let bytes=0;
    for await(const raw of req){options.signal.throwIfAborted();options.assertAvailable();const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);bytes+=chunk.length;if(bytes>initial.status.sizeBytes)throw fail('EXPORT_FILE_SIZE_MISMATCH',400);digest.update(chunk);let offset=0;while(offset<chunk.length){const written=await handle.write(chunk,offset);if(!written.bytesWritten)throw fail();offset+=written.bytesWritten;}}
    if(bytes!==initial.status.sizeBytes||digest.digest('hex')!==initial.status.sha256)throw fail('EXPORT_FILE_HASH_MISMATCH',400);
    await handle.sync();await handle.close();handle=undefined;
    if(identity(input.data.projectId,input.data.exportId).digest!==initial.digest)throw fail();
    options.validateDirectory(path.dirname(initial.file));options.validateFile(initial.file,true);options.signal.throwIfAborted();
    // link creates the original destination exclusively; an existing file is
    // never replaced, even if it appears after the initial missing check.
    await link(part,initial.file);initial.status.status='present';
   }finally{
    try{try{await handle?.close();}finally{await unlink(part).catch(error=>{if(!object(error)||error.code!=='ENOENT')throw error;});}}
    finally{active.delete(input.data.exportId);release();}
   }
  }else if(req.method==='POST')req.resume();
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,data:initial.status}));return true;
 }};
}
