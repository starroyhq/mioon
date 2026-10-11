import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,fstatSync,fsyncSync,closeSync} from 'node:fs';
import {ensurePrivateDirectory,validateManagedDirectory,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';
import {FRAME_LIMITS,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,frameReceiptSchema,canonicalFrameInput as canonical} from '../../contracts/src/frame-extraction.mjs';

const failure=()=>Object.assign(new Error('The complete local frame result cannot be verified.'),{code:'FRAME_RESULT_INVALID'});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** Complete, bounded PNG + immutable manifest checkpoints. Merely finding a
 * PNG never authorizes recovery. Reads do not repair storage or make directories.
 * Every path is derived from an accepted task or a strictly validated receipt. */
export function createFrameStorage(store,{validatePng}){
 const root=store.root,directory=path.join(root,'frame-staging');
 function syncDirectory(value){
  const before=validateManagedDirectory(value,{root});let fd;
  try{fd=openSync(value,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);
   if(!opened.isDirectory()||before.dev!==opened.dev||before.ino!==opened.ino)throw failure();
   fsyncSync(fd);const after=validateManagedDirectory(value,{root});if(after.dev!==opened.dev||after.ino!==opened.ino)throw failure();
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 function paths(task){if(!uuid(task.id))throw failure();return {png:path.join(directory,`${task.id}.png`),receipt:path.join(directory,`${task.id}.json`)};}
 function validateReceipt(task,value){
  const source=task.snapshot.source,requested=task.snapshot.requested;
  if(!frameReceiptSchema.safeParse(value).success||value.taskId!==task.id||value.projectId!==task.projectId||value.inputHash!==task.inputHash||
   value.sourceAssetId!==source.assetId||value.sourceHash!==source.sha256||value.sourceFrame!==requested.sourceFrame||value.fps!==requested.fps||
   value.probe.width!==source.width||value.probe.height!==source.height)throw failure();
  if(task.stagedReceipt!==null&&task.stagedReceipt!==undefined){let saved;try{saved=JSON.parse(task.stagedReceipt);}catch{throw failure();}if(canonical(saved)!==canonical(value))throw failure();}
  return value;
 }
 function readReceipt(task){
  if(!validateManagedDirectory(directory,{root,allowMissing:true,private:true}))return null;
  const raw=readPrivateFile(paths(task).receipt,{root,allowMissing:true,maxBytes:FRAME_LIMITS.receiptBytes,encoding:'utf8'});
  if(raw===null)return null;let value;try{value=JSON.parse(raw);}catch{throw failure();}return validateReceipt(task,value);
 }
 async function verify(task,receipt,check,{signal}={}){
  check();validateReceipt(task,receipt);
  // The complete manifest remains required even after final media publication.
  const manifest=readReceipt(task);if(!manifest||canonical(manifest)!==canonical(receipt))throw failure();
  const final=path.join(root,'media',`${receipt.assetId}.png`),staged=readPrivateFile(paths(task).png,{root,allowMissing:true,maxBytes:FRAME_LIMITS.resultBytes});
  const bytes=staged??readPrivateFile(final,{root,allowMissing:true,maxBytes:FRAME_LIMITS.resultBytes});
  if(!bytes||bytes.length!==receipt.byteLength||digest(bytes)!==receipt.sha256)throw failure();
  await validatePng(bytes,{width:receipt.width,height:receipt.height,opaque:true,signal});check();
  return {bytes,final};
 }
 async function stage(task,result,check,{signal}={}){
  check();const source=task.snapshot.source,ratio=Math.min(1,FRAME_LIMITS.resultMaxEdge/Math.max(source.width,source.height));
  const width=Math.max(1,Math.round(source.width*ratio)),height=Math.max(1,Math.round(source.height*ratio));
  if(!Buffer.isBuffer(result?.bytes)||!result.bytes.length||result.bytes.length>FRAME_LIMITS.resultBytes)throw failure();
  const provenance=result.provenance;
  if(!provenance||provenance.profileId!==FRAME_PROFILE_ID||provenance.selectionRule!==FRAME_SELECTION_RULE||provenance.sourceFrame!==task.snapshot.requested.sourceFrame||provenance.fps!==30||provenance.sourceHash!==source.sha256)throw failure();
  // Freeze caller bytes before asynchronous validation and durable publication.
  const bytes=Buffer.from(result.bytes);await validatePng(bytes,{width,height,opaque:true,signal});check();
  const receipt={schemaVersion:1,projectId:task.projectId,taskId:task.id,inputHash:task.inputHash,
   sourceAssetId:source.assetId,sourceHash:source.sha256,sourceFrame:task.snapshot.requested.sourceFrame,fps:30,
   profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,assetId:randomUUID(),sha256:digest(bytes),mimeType:'image/png',width,height,byteLength:bytes.length,probe:structuredClone(provenance.probe)};
  validateReceipt(task,receipt);check();ensurePrivateDirectory(directory,{create:true});validateManagedDirectory(directory,{root,private:true});syncDirectory(root);check();
  writePrivateFileAtomic(paths(task).png,bytes,{root,maxBytes:FRAME_LIMITS.resultBytes,replace:false});syncDirectory(directory);check();
  writePrivateFileAtomic(paths(task).receipt,canonical(receipt),{root,maxBytes:FRAME_LIMITS.receiptBytes,replace:false});syncDirectory(directory);return receipt;
 }
 async function publish(task,receipt,check,{signal}={}){
  const {bytes,final}=await verify(task,receipt,check,{signal});check();
  const existing=readPrivateFile(final,{root,allowMissing:true,maxBytes:FRAME_LIMITS.resultBytes});
  if(existing){if(existing.length!==receipt.byteLength||digest(existing)!==receipt.sha256)throw failure();}
  else{check();writePrivateFileAtomic(final,bytes,{root,maxBytes:FRAME_LIMITS.resultBytes,replace:false});}
  syncDirectory(path.dirname(final));check();return {relativePath:`media/${receipt.assetId}.png`,sizeBytes:receipt.byteLength};
 }
 function discardStagedPng(task,check){check();removePrivateFile(paths(task).png,{root,maxBytes:FRAME_LIMITS.resultBytes});}
 return {stage,readReceipt,validateReceipt,verify,publish,discardStagedPng};
}
