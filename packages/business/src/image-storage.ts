import {validateComfyReceiptOwnership} from './comfy/ownership.ts';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,fstatSync,fsyncSync,closeSync} from 'node:fs';
import {IMAGE_LIMITS,imageReceiptSchema} from '@mioon/contracts';
import {ensurePrivateDirectory,validateManagedDirectory,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';

const failure=()=>Object.assign(new Error('The local image result cannot be verified.'),{code:'IMAGE_RESULT_INVALID'});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const dimensions=task=>task.snapshot.providerId==='comfy-local'?{width:512,height:512}:{width:1024,height:1024};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** Bounded, task-derived private files. A complete manifest is the durable
 * local result checkpoint; a partial PNG alone never authorizes recovery.
 * No read invokes an adapter, writes a file or repairs permissions. */
export function createImageStorage(store,{validatePng}){
 const root=store.root,directory=path.join(root,'image-staging');
 function syncDirectory(value){
  const before=validateManagedDirectory(value,{root});let fd;
  try{fd=openSync(value,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);
   if(!opened.isDirectory()||before.dev!==opened.dev||before.ino!==opened.ino)throw failure();
   fsyncSync(fd);const after=validateManagedDirectory(value,{root});if(after.dev!==opened.dev||after.ino!==opened.ino)throw failure();
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 const paths=task=>{
  if(!uuid(task.id))throw failure();
  return {png:path.join(directory,`${task.id}.png`),receipt:path.join(directory,`${task.id}.json`)};
 };
 function validateReceipt(task,value){
  if(!imageReceiptSchema.safeParse(value).success||value.taskId!==task.id||value.projectId!==task.projectId||value.groupId!==task.groupId||value.inputHash!==task.inputHash||value.isMock!==(task.snapshot.providerId==='mock')||(task.snapshot.providerId==='comfy-local'?(value.schemaVersion!==2||value.providerId!=='comfy-local'||value.width!==512||value.height!==512):(value.schemaVersion!==1||value.width!==1024||value.height!==1024)))throw failure();
  if(task.snapshot.providerId==='comfy-local'){let input;try{input=JSON.parse(task.input);}catch{throw failure();}validateComfyReceiptOwnership(store.db,task,input,value);}
  return value;
 }
 function readReceipt(task){
  if(!validateManagedDirectory(directory,{root,allowMissing:true,private:true}))return null;
  const raw=readPrivateFile(paths(task).receipt,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.receiptBytes,encoding:'utf8'});
  if(raw===null)return null;
  let value;try{value=JSON.parse(raw);}catch{throw failure();}
  return validateReceipt(task,value);
 }
 async function verifiedBytes(task,receipt,check){
  validateReceipt(task,receipt);check();
  const final=path.join(root,'media',`${receipt.assetId}.png`);
  const staged=readPrivateFile(paths(task).png,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.resultBytes});
  const bytes=staged??readPrivateFile(final,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.resultBytes});
  if(!bytes||bytes.length!==receipt.byteLength||digest(bytes)!==receipt.sha256)throw failure();
  await validatePng(bytes,{...dimensions(task),opaque:true});check();
  return {bytes,final};
 }
 async function stage(task,result,check){
  check();
  if(!Buffer.isBuffer(result?.bytes)||!result.bytes.length||result.bytes.length>IMAGE_LIMITS.resultBytes)throw failure();
  await validatePng(result.bytes,{...dimensions(task),opaque:true});check();
  const receipt={schemaVersion:task.snapshot.providerId==='comfy-local'?2:1,...(task.snapshot.providerId==='comfy-local'?{providerId:'comfy-local'}:{}),taskId:task.id,projectId:task.projectId,groupId:task.groupId,inputHash:task.inputHash,
   assetId:randomUUID(),versionId:randomUUID(),sha256:digest(result.bytes),mimeType:'image/png',...dimensions(task),
   byteLength:result.bytes.length,isMock:task.snapshot.providerId==='mock'};
  validateReceipt(task,receipt);
  ensurePrivateDirectory(directory,{create:true});
  validateManagedDirectory(directory,{root,private:true});syncDirectory(root);check();
  // Only an explicitly re-observed Comfy result can reuse a partial stage.
  // The caller has already pinned the full remote graph and exact byte hash.
  const partial=task.snapshot.providerId==='comfy-local'?readPrivateFile(paths(task).png,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.resultBytes}):null;
  if(partial){if(partial.length!==receipt.byteLength||digest(partial)!==receipt.sha256)throw failure();}
  else writePrivateFileAtomic(paths(task).png,result.bytes,{root,maxBytes:IMAGE_LIMITS.resultBytes,replace:false});
  syncDirectory(directory);
  // The manifest is published only after complete, verified PNG bytes. Its
  // immutable input hash binds recovery to this exact accepted generation.
  writePrivateFileAtomic(paths(task).receipt,JSON.stringify(receipt),{root,maxBytes:IMAGE_LIMITS.receiptBytes,replace:false});
  syncDirectory(directory);
  return receipt;
 }
 async function publish(task,receipt,check){
  const {bytes,final}=await verifiedBytes(task,receipt,check);
  const existing=readPrivateFile(final,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.resultBytes});
  if(existing){if(existing.length!==receipt.byteLength||digest(existing)!==receipt.sha256)throw failure();}
  else{check();writePrivateFileAtomic(final,bytes,{root,maxBytes:IMAGE_LIMITS.resultBytes,replace:false});}
  syncDirectory(path.dirname(final));
  return {relativePath:`media/${receipt.assetId}.png`,sizeBytes:receipt.byteLength};
 }
 function discardStagedPng(task,check){
  check();removePrivateFile(paths(task).png,{root,maxBytes:IMAGE_LIMITS.resultBytes});
 }
 return {stage,readReceipt,validateReceipt,publish,discardStagedPng};
}
