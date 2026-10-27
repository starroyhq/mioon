import {validateComfyReceiptOwnership} from './comfy/ownership.ts';
import type {ImageGenerationInput} from './images/reviews.ts';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,fstatSync,fsyncSync,closeSync} from 'node:fs';
import {IMAGE_LIMITS,imageReceiptSchema,imageResultGeometry} from '@mioon/contracts';
import {ensurePrivateDirectory,validateManagedDirectory,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';
import {validatePng as validatePngBytes} from './images/png.ts';
import type {PngMetadata} from './images/png.ts';

export interface ImageStorageSnapshot {
 readonly providerId?: string;
 readonly [key: string]: unknown;
}
export interface ImageStorageTask {
 readonly id: string;
 readonly projectId: string;
 readonly groupId: string;
 readonly inputHash: string;
 readonly input: string;
 readonly snapshot: ImageStorageSnapshot;
}
export interface ImageReceipt {
 readonly schemaVersion: 1 | 2 | 3;
 readonly providerId?: string;
 readonly taskId: string;
 readonly projectId: string;
 readonly groupId: string;
 readonly inputHash: string;
 readonly assetId: string;
 readonly versionId: string;
 readonly sha256: string;
 readonly mimeType: 'image/png';
 readonly width: number;
 readonly height: number;
 readonly byteLength: number;
 readonly isMock: boolean;
}
export interface ImageStoredBytes {readonly bytes: Buffer; readonly final: string}
export interface ImagePublishedResult {readonly relativePath: string; readonly sizeBytes: number}
export interface ImageStorage {
 stage(task: ImageStorageTask,result: {readonly bytes?: unknown},check: ()=>void): Promise<ImageReceipt>;
 readReceipt(task: ImageStorageTask): ImageReceipt | null;
 validateReceipt(task: ImageStorageTask,value: unknown): ImageReceipt;
 publish(task: ImageStorageTask,receipt: ImageReceipt,check: ()=>void): Promise<ImagePublishedResult>;
 discardStagedPng(task: ImageStorageTask,check: ()=>void): void;
}

const failure=(): Error=>Object.assign(new Error('The local image result cannot be verified.'),{code:'IMAGE_RESULT_INVALID'});
const digest=(bytes: Buffer): string=>createHash('sha256').update(bytes).digest('hex');
const dimensions=(task: ImageStorageTask): {width: number; height: number}=>{const {width,height}=imageResultGeometry(task.snapshot);return {width,height};};
const uuid=(value: unknown): boolean=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** Bounded, task-derived private files. A complete manifest is the durable
 * local result checkpoint; a partial PNG alone never authorizes recovery.
 * No read invokes an adapter, writes a file or repairs permissions. */
export function createImageStorage(store: {readonly root: string; readonly db: import('node:sqlite').DatabaseSync},
 {validatePng}: {readonly validatePng: (bytes: unknown,options?: {width?: unknown; height?: unknown; signal?: AbortSignal; opaque?: boolean})=>Promise<PngMetadata>}): ImageStorage {
 const root=store.root,directory=path.join(root,'image-staging');
 function syncDirectory(value: string): void {
  const before=validateManagedDirectory(value,{root});let fd;
  try{
   if(!before)throw failure();
   fd=openSync(value,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);
   if(!opened.isDirectory()||before.dev!==opened.dev||before.ino!==opened.ino)throw failure();
   fsyncSync(fd);const after=validateManagedDirectory(value,{root});if(!after||after.dev!==opened.dev||after.ino!==opened.ino)throw failure();
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 const paths=(task: ImageStorageTask): {png: string; receipt: string}=>{
  if(!uuid(task.id))throw failure();
  return {png:path.join(directory,`${task.id}.png`),receipt:path.join(directory,`${task.id}.json`)};
 };
 function validateReceipt(task: ImageStorageTask,value: unknown): ImageReceipt {
  if(!imageReceiptSchema.safeParse(value).success)throw failure();
  const receipt=value as ImageReceipt;
  if(receipt.taskId!==task.id||receipt.projectId!==task.projectId||receipt.groupId!==task.groupId||receipt.inputHash!==task.inputHash||receipt.isMock!==(task.snapshot.providerId==='mock')||
   receipt.schemaVersion!==imageResultGeometry(task.snapshot).schemaVersion||(receipt.schemaVersion===2)!==(receipt.providerId==='comfy-local')||receipt.width!==dimensions(task).width||receipt.height!==dimensions(task).height)throw failure();
  if(task.snapshot.providerId==='comfy-local'){let input: unknown;try{input=JSON.parse(task.input);}catch{throw failure();}validateComfyReceiptOwnership(store.db,task,input as unknown as ImageGenerationInput,receipt);}
  return receipt;
 }
 function readReceipt(task: ImageStorageTask): ImageReceipt | null {
  if(!validateManagedDirectory(directory,{root,allowMissing:true,private:true}))return null;
  const raw=readPrivateFile(paths(task).receipt,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.receiptBytes,encoding:'utf8'});
  if(raw===null)return null;
  if(typeof raw!=='string')throw failure();
  let value: unknown;try{value=JSON.parse(raw);}catch{throw failure();}
  return validateReceipt(task,value);
 }
 async function verifiedBytes(task: ImageStorageTask,receipt: ImageReceipt,check: ()=>void): Promise<ImageStoredBytes> {
  validateReceipt(task,receipt);check();
  const final=path.join(root,'media',`${receipt.assetId}.png`);
  const staged=readPrivateFile(paths(task).png,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.resultBytes});
  const bytes=staged??readPrivateFile(final,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.resultBytes});
  if(!bytes||typeof bytes==='string'||bytes.length!==receipt.byteLength||digest(bytes)!==receipt.sha256)throw failure();
  await validatePng(bytes,{...dimensions(task),opaque:true});check();
  return {bytes,final};
 }
 async function stage(task: ImageStorageTask,result: {readonly bytes?: unknown},check: ()=>void): Promise<ImageReceipt> {
  check();
  if(!Buffer.isBuffer(result?.bytes)||!result.bytes.length||result.bytes.length>IMAGE_LIMITS.resultBytes)throw failure();
  await validatePng(result.bytes,{...dimensions(task),opaque:true});check();
  const receipt: ImageReceipt={schemaVersion:imageResultGeometry(task.snapshot).schemaVersion,...(task.snapshot.providerId==='comfy-local'?{providerId:'comfy-local'}:{}),taskId:task.id,projectId:task.projectId,groupId:task.groupId,inputHash:task.inputHash,
   assetId:randomUUID(),versionId:randomUUID(),sha256:digest(result.bytes),mimeType:'image/png',...dimensions(task),
   byteLength:result.bytes.length,isMock:task.snapshot.providerId==='mock'};
  validateReceipt(task,receipt);
  ensurePrivateDirectory(directory,{create:true});
  validateManagedDirectory(directory,{root,private:true});syncDirectory(root);check();
  // Only an explicitly re-observed Comfy result can reuse a partial stage.
  // The caller has already pinned the full remote graph and exact byte hash.
  const partial=task.snapshot.providerId==='comfy-local'?readPrivateFile(paths(task).png,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.resultBytes}):null;
  if(partial){if(typeof partial==='string'||partial.length!==receipt.byteLength||digest(partial)!==receipt.sha256)throw failure();}
  else writePrivateFileAtomic(paths(task).png,result.bytes,{root,maxBytes:IMAGE_LIMITS.resultBytes,replace:false});
  syncDirectory(directory);
  // The manifest is published only after complete, verified PNG bytes. Its
  // immutable input hash binds recovery to this exact accepted generation.
  writePrivateFileAtomic(paths(task).receipt,JSON.stringify(receipt),{root,maxBytes:IMAGE_LIMITS.receiptBytes,replace:false});
  syncDirectory(directory);
  return receipt;
 }
 async function publish(task: ImageStorageTask,receipt: ImageReceipt,check: ()=>void): Promise<ImagePublishedResult> {
  const {bytes,final}=await verifiedBytes(task,receipt,check);
  const existing=readPrivateFile(final,{root,allowMissing:true,maxBytes:IMAGE_LIMITS.resultBytes});
  if(existing){if(typeof existing==='string'||existing.length!==receipt.byteLength||digest(existing)!==receipt.sha256)throw failure();}
  else{check();writePrivateFileAtomic(final,bytes,{root,maxBytes:IMAGE_LIMITS.resultBytes,replace:false});}
  syncDirectory(path.dirname(final));
  return {relativePath:`media/${receipt.assetId}.png`,sizeBytes:receipt.byteLength};
 }
 function discardStagedPng(task: ImageStorageTask,check: ()=>void): void {
  check();removePrivateFile(paths(task).png,{root,maxBytes:IMAGE_LIMITS.resultBytes});
 }
 return {stage,readReceipt,validateReceipt,publish,discardStagedPng};
}
