import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,fstatSync,fsyncSync,closeSync} from 'node:fs';
import {ensurePrivateDirectory,validateManagedDirectory,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';
import {FRAME_LIMITS,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,frameReceiptSchema,canonicalFrameInput as canonical} from '../../contracts/src/frame-extraction.ts';
import {validatePng as validatePngBytes} from './images/png.ts';
import type {PngMetadata} from './images/png.ts';

export interface FrameSourceSnapshot {
 readonly assetId: string;
 readonly sha256: string;
 readonly mimeType: string;
 readonly sizeBytes: number;
 readonly relativePath: string;
 readonly duration: number;
 readonly width: number;
 readonly height: number;
 readonly [key: string]: unknown;
}
export interface FrameStorageSnapshot {
 readonly source: FrameSourceSnapshot;
 readonly requested: Readonly<{sourceFrame: number; fps: number; [key: string]: unknown}>;
 readonly [key: string]: unknown;
}
export interface FrameStorageTask {
 readonly id: string;
 readonly projectId: string;
 readonly inputHash: string;
 readonly snapshot: FrameStorageSnapshot;
 readonly stagedReceipt?: string | null;
}
export interface FrameProbe {
 readonly streamIndex: number;
 readonly timeBaseNumerator: number;
 readonly timeBaseDenominator: number;
 readonly width: number;
 readonly height: number;
 readonly rotation: number;
 readonly sarNumerator: number;
 readonly sarDenominator: number;
 readonly [key: string]: unknown;
}
export interface FrameReceipt {
 readonly schemaVersion: 1;
 readonly projectId: string;
 readonly taskId: string;
 readonly inputHash: string;
 readonly sourceAssetId: string;
 readonly sourceHash: string;
 readonly sourceFrame: number;
 readonly fps: number;
 readonly profileId: string;
 readonly selectionRule: string;
 readonly assetId: string;
 readonly sha256: string;
 readonly mimeType: 'image/png';
 readonly width: number;
 readonly height: number;
 readonly byteLength: number;
 readonly probe: Record<string, unknown>;
}
export interface FrameStoredPng {readonly bytes: Buffer; readonly final: string}
export interface FramePublishedResult {readonly relativePath: string; readonly sizeBytes: number}
export interface FrameStorage {
 stage(task: FrameStorageTask,result: {readonly bytes?: unknown; readonly provenance?: unknown},check: ()=>void,options?: {readonly signal?: AbortSignal}): Promise<FrameReceipt>;
 readReceipt(task: FrameStorageTask): FrameReceipt | null;
 validateReceipt(task: FrameStorageTask,value: unknown): FrameReceipt;
 verify(task: FrameStorageTask,receipt: FrameReceipt,check: ()=>void,options?: {readonly signal?: AbortSignal}): Promise<FrameStoredPng>;
 publish(task: FrameStorageTask,receipt: FrameReceipt,check: ()=>void,options?: {readonly signal?: AbortSignal}): Promise<FramePublishedResult>;
 discardStagedPng(task: FrameStorageTask,check: ()=>void): void;
}

const failure=(): Error=>Object.assign(new Error('The complete local frame result cannot be verified.'),{code:'FRAME_RESULT_INVALID'});
const digest=(bytes: Buffer): string=>createHash('sha256').update(bytes).digest('hex');
const uuid=(value: unknown): boolean=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Complete, bounded PNG + immutable manifest checkpoints. Merely finding a
 * PNG never authorizes recovery. Reads do not repair storage or make directories.
 * Every path is derived from an accepted task or a strictly validated receipt. */
export function createFrameStorage(store: {readonly root: string},{validatePng}: {readonly validatePng: (bytes: unknown,options?: {width?: unknown; height?: unknown; signal?: AbortSignal; opaque?: boolean})=>Promise<PngMetadata>}): FrameStorage {
 const root=store.root,directory=path.join(root,'frame-staging');
 function syncDirectory(value: string): void {
  const before=validateManagedDirectory(value,{root});let fd;
  try{
   if(!before)throw failure();
   fd=openSync(value,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);
   if(!opened.isDirectory()||before.dev!==opened.dev||before.ino!==opened.ino)throw failure();
   fsyncSync(fd);const after=validateManagedDirectory(value,{root});if(!after||after.dev!==opened.dev||after.ino!==opened.ino)throw failure();
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 function paths(task: FrameStorageTask): {png: string; receipt: string} {
  if(!uuid(task.id))throw failure();
  return {png:path.join(directory,`${task.id}.png`),receipt:path.join(directory,`${task.id}.json`)};
 }
 function validateReceipt(task: FrameStorageTask,value: unknown): FrameReceipt {
  const source=task.snapshot.source,requested=task.snapshot.requested;
  if(!frameReceiptSchema.safeParse(value).success)throw failure();
  const receipt=value as FrameReceipt;
  if(receipt.taskId!==task.id||receipt.projectId!==task.projectId||receipt.inputHash!==task.inputHash||
   receipt.sourceAssetId!==source.assetId||receipt.sourceHash!==source.sha256||receipt.sourceFrame!==requested.sourceFrame||receipt.fps!==requested.fps)throw failure();
  if(task.stagedReceipt!==null&&task.stagedReceipt!==undefined){let saved: unknown;try{saved=JSON.parse(task.stagedReceipt);}catch{throw failure();}if(canonical(saved)!==canonical(receipt))throw failure();}
  return receipt;
 }
 function readReceipt(task: FrameStorageTask): FrameReceipt | null {
  if(!validateManagedDirectory(directory,{root,allowMissing:true,private:true}))return null;
  const raw=readPrivateFile(paths(task).receipt,{root,allowMissing:true,maxBytes:FRAME_LIMITS.receiptBytes,encoding:'utf8'});
  if(raw===null)return null;if(typeof raw!=='string')throw failure();
  let value: unknown;try{value=JSON.parse(raw);}catch{throw failure();}return validateReceipt(task,value);
 }
 async function verify(task: FrameStorageTask,receipt: FrameReceipt,check: ()=>void,{signal}: {readonly signal?: AbortSignal}={}): Promise<FrameStoredPng> {
  check();validateReceipt(task,receipt);
  // The complete manifest remains required even after final media publication.
  const manifest=readReceipt(task);if(!manifest||canonical(manifest)!==canonical(receipt))throw failure();
  const final=path.join(root,'media',`${receipt.assetId}.png`),staged=readPrivateFile(paths(task).png,{root,allowMissing:true,maxBytes:FRAME_LIMITS.resultBytes});
  const bytes=staged??readPrivateFile(final,{root,allowMissing:true,maxBytes:FRAME_LIMITS.resultBytes});
  if(!bytes||typeof bytes==='string'||bytes.length!==receipt.byteLength||digest(bytes)!==receipt.sha256)throw failure();
  await validatePng(bytes,{width:receipt.width,height:receipt.height,opaque:true,signal});check();
  return {bytes,final};
 }
 async function stage(task: FrameStorageTask,result: {readonly bytes?: unknown; readonly provenance?: unknown},check: ()=>void,{signal}: {readonly signal?: AbortSignal}={}): Promise<FrameReceipt> {
  check();const source=task.snapshot.source,ratio=Math.min(1,FRAME_LIMITS.resultMaxEdge/Math.max(source.width,source.height));
  const width=Math.max(1,Math.round(source.width*ratio)),height=Math.max(1,Math.round(source.height*ratio));
  if(!Buffer.isBuffer(result?.bytes)||!result.bytes.length||result.bytes.length>FRAME_LIMITS.resultBytes)throw failure();
  const provenance=result.provenance;
  if(!isRecord(provenance)||provenance.profileId!==FRAME_PROFILE_ID||provenance.selectionRule!==FRAME_SELECTION_RULE||provenance.sourceFrame!==task.snapshot.requested.sourceFrame||provenance.fps!==30||provenance.sourceHash!==source.sha256)throw failure();
  // Freeze caller bytes before asynchronous validation and durable publication.
  const bytes=Buffer.from(result.bytes);await validatePng(bytes,{width,height,opaque:true,signal});check();
  const receipt: FrameReceipt={schemaVersion:1,projectId:task.projectId,taskId:task.id,inputHash:task.inputHash,
   sourceAssetId:source.assetId,sourceHash:source.sha256,sourceFrame:task.snapshot.requested.sourceFrame,fps:30,
   profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,assetId:randomUUID(),sha256:digest(bytes),mimeType:'image/png',width,height,byteLength:bytes.length,
   probe:structuredClone(isRecord(provenance.probe)?provenance.probe:{})};
  validateReceipt(task,receipt);check();ensurePrivateDirectory(directory,{create:true});validateManagedDirectory(directory,{root,private:true});syncDirectory(root);check();
  writePrivateFileAtomic(paths(task).png,bytes,{root,maxBytes:FRAME_LIMITS.resultBytes,replace:false});syncDirectory(directory);check();
  writePrivateFileAtomic(paths(task).receipt,canonical(receipt),{root,maxBytes:FRAME_LIMITS.receiptBytes,replace:false});syncDirectory(directory);return receipt;
 }
 async function publish(task: FrameStorageTask,receipt: FrameReceipt,check: ()=>void,{signal}: {readonly signal?: AbortSignal}={}): Promise<FramePublishedResult> {
  const {bytes,final}=await verify(task,receipt,check,{signal});check();
  const existing=readPrivateFile(final,{root,allowMissing:true,maxBytes:FRAME_LIMITS.resultBytes});
  if(existing){if(typeof existing==='string'||existing.length!==receipt.byteLength||digest(existing)!==receipt.sha256)throw failure();}
  else{check();writePrivateFileAtomic(final,bytes,{root,maxBytes:FRAME_LIMITS.resultBytes,replace:false});}
  syncDirectory(path.dirname(final));check();return {relativePath:`media/${receipt.assetId}.png`,sizeBytes:receipt.byteLength};
 }
 function discardStagedPng(task: FrameStorageTask,check: ()=>void): void {check();removePrivateFile(paths(task).png,{root,maxBytes:FRAME_LIMITS.resultBytes});}
 return {stage,readReceipt,validateReceipt,verify,publish,discardStagedPng};
}
