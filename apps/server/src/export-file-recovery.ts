import {isProjectDatabase} from '../../../packages/business/src/project-file/held-files.ts';
import {validAssetLocator} from '../../../packages/business/src/asset-reference-record.ts';
import {resolveReferencePath} from '../../../packages/business/src/media-reference/index.ts';
import {mediaReferenceSchema} from '../../../packages/contracts/src/media-reference.ts';
import {ensurePrivateDirectory,validatePrivateDirectory} from '../../../packages/contracts/src/private-storage.ts';
import {registeredProjectStoreForDatabase} from '../../../packages/business/src/project-media-storage.ts';
import {isPublishedProjectOutput,restorePublishedProjectOutput} from '../../../packages/business/src/project-output-publication.ts';
import {exportOutputArtifactIdentity} from '../../../packages/contracts/src/output-artifact.ts';
import path from 'node:path';
import {constants} from 'node:fs';
import {open,link,unlink,lstat,realpath} from 'node:fs/promises';
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
 function identity(projectId:string,exportId:string):{file:string;digest:string;asset:Record<string,unknown>;status:ExportFileStatus}{
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
  if(!object(asset)||!object(record)||typeof asset.id!=='string'||asset.projectId!==projectId||asset.id!==record.assetId||asset.mimeType!=='video/mp4'||asset.provenance!=='export'||!(isProjectDatabase(options.db)?validAssetLocator(options.db,asset)&&object(asset.producer)&&asset.producer.kind==='export'&&asset.producer.id===exportId&&isPublishedProjectOutput(asset,{projectId,owner:{kind:'export',id:exportId,requestId:typeof record.requestId==='string'?record.requestId:exportId,inputHash:createHash('sha256').update(exportOutputArtifactIdentity(record)).digest('hex')},targetKind:'exports',mimeType:'video/mp4'}):typeof asset.relativePath==='string'&&new RegExp(`^media/export-${exportId}-[a-f0-9-]{36}\\.mp4$`,'u').test(asset.relativePath))||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(asset.sha256)||typeof asset.sizeBytes!=='number'||!Number.isSafeInteger(asset.sizeBytes)||asset.sizeBytes<1||asset.sizeBytes>8*1024**3)throw fail();
  if(!isProjectDatabase(options.db)&&options.db.prepare("SELECT 1 FROM assets WHERE id<>? AND json_extract(data,'$.relativePath')=? LIMIT 1").get(asset.id,String(asset.relativePath)))throw fail();
  const file=isProjectDatabase(options.db)?resolveReferencePath(options.root,mediaReferenceSchema.parse(asset.reference)):path.join(options.root,String(asset.relativePath)),digest=createHash('sha256').update(JSON.stringify([timeline?.identityDigest??record,asset])).digest('hex');
  if(!file)throw fail();
  return {file,digest,asset,status:{projectId,exportId,assetId:asset.id,sizeBytes:asset.sizeBytes,sha256:asset.sha256,status:'missing'} satisfies ExportFileStatus};
 }
 const exists=async(file:string)=>{
  if(!isProjectDatabase(options.db))options.validateFile(file,true);
  else{
   const store=registeredProjectStoreForDatabase(options.db);
   if(!store||store.projectDir!==options.root||await realpath(options.root)!==options.root||path.dirname(file)!==path.join(options.root,'导出'))throw fail();
   try{const parent=await lstat(path.dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink()||await realpath(path.dirname(file))!==path.dirname(file))throw fail();}
   catch(error){if(object(error)&&error.code==='ENOENT')return false;throw error;}
  }
  try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail();return true;}catch(error){if(object(error)&&error.code==='ENOENT')return false;throw error;}
 };
 return {async handle(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
  if(url.pathname!=='/api/export-files')return false;
  if(req.method!=='GET'&&req.method!=='POST')throw fail('METHOD_NOT_ALLOWED',405);
  const keys=[...url.searchParams.keys()];if(keys.length!==2||new Set(keys).size!==2)throw fail('VALIDATION_ERROR',400);
  const input=exportFileIdentitySchema.safeParse(Object.fromEntries(url.searchParams));if(!input.success)throw fail('VALIDATION_ERROR',400);
  const initial=identity(input.data.projectId,input.data.exportId);initial.status.status=await exists(initial.file)?'present':'missing';
  if(req.method==='POST'&&initial.status.status==='missing'){
   if(active.has(input.data.exportId))throw fail('EXPORT_FILE_RECOVERY_BUSY');
   const length=req.headers['content-length'];if(length!==String(initial.status.sizeBytes))throw fail('EXPORT_FILE_SIZE_MISMATCH',400);
   const store=isProjectDatabase(options.db)?registeredProjectStoreForDatabase(options.db):undefined;
   if(isProjectDatabase(options.db)&&(!store||store.projectDir!==options.root))throw fail();
   const release=options.hold?.()??(()=>{});
   const stageDirectory=store?path.join(store.tempDir,'export-recovery'):path.join(options.root,'media');
   active.add(input.data.exportId);const part=path.join(stageDirectory,`.recover-${randomUUID()}.part`);let handle,complete=false,published=false;
   try{
    if(store){validatePrivateDirectory(store.tempDir);ensurePrivateDirectory(stageDirectory,{create:true});validatePrivateDirectory(stageDirectory);}else options.validateDirectory(path.dirname(part));
    handle=await open(part,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const digest=createHash('sha256');let bytes=0;
    for await(const raw of req){options.signal.throwIfAborted();options.assertAvailable();const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);bytes+=chunk.length;if(bytes>initial.status.sizeBytes)throw fail('EXPORT_FILE_SIZE_MISMATCH',400);digest.update(chunk);let offset=0;while(offset<chunk.length){const written=await handle.write(chunk,offset);if(!written.bytesWritten)throw fail();offset+=written.bytesWritten;}}
    if(bytes!==initial.status.sizeBytes||digest.digest('hex')!==initial.status.sha256)throw fail('EXPORT_FILE_HASH_MISMATCH',400);
    await handle.sync();await handle.close();handle=undefined;complete=true;
    const beforeEffect=()=>{options.assertAvailable();options.signal.throwIfAborted();if(identity(input.data.projectId,input.data.exportId).digest!==initial.digest)throw fail();};
    beforeEffect();
    if(store)await restorePublishedProjectOutput(store,{asset:initial.asset,stageFile:part},{signal:options.signal,beforeEffect});
    else{
     options.validateDirectory(path.dirname(initial.file));options.validateFile(initial.file,true);beforeEffect();
     // The isolated legacy workspace keeps its existing exclusive link path.
     await link(part,initial.file);
    }
    initial.status.status='present';published=true;
   }finally{
    // A complete private artifact remains available to its durable recovery
    // intent when publication fails. Incomplete uploads have no result to keep.
    try{try{await handle?.close();}finally{if(!store||!complete||published)await unlink(part).catch(error=>{if(!object(error)||error.code!=='ENOENT')throw error;});}}
    finally{active.delete(input.data.exportId);release();}
   }
  }else if(req.method==='POST')req.resume();
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,data:initial.status}));return true;
 }};
}
