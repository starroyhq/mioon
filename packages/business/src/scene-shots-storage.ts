import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants,lstatSync,openSync,fstatSync,fsyncSync,closeSync} from 'node:fs';
import {ensurePrivateDirectory,validateManagedDirectory,readPrivateFile,writePrivateFileAtomic,removePrivateFile,getWindowsManagedFileIO} from '@mioon/contracts/private-storage';
import {FRAME_LIMITS,SCENE_LIMITS,sceneShotsReceiptSchema,sceneShotPlan,canonicalSceneInput as canonical} from '@mioon/contracts';
import type {SceneShotsReceipt,SceneShotsSnapshot} from '@mioon/contracts';
import {storeDirectories} from './store-layout.ts';
import {isProjectStore} from './project-file/store.ts';
import {projectMediaDirectory,readProjectMediaFile,writeProjectMediaFileAtomic} from './project-media-storage.ts';
import {publishProjectOutput,readPublishedProjectOutput} from './project-output-publication.ts';
import type {PublishedProjectOutput,ProjectOutputOwner} from './project-output-publication.ts';

export interface SceneShotsStorageTask {
 readonly id: string;
 readonly projectId: string;
 readonly requestId: string;
 readonly inputHash: string;
 readonly snapshot: SceneShotsSnapshot;
 readonly stagedReceipt?: string|null;
}
export type ScenePublishedResult=PublishedProjectOutput|{readonly relativePath: string; readonly sizeBytes: number};
export interface SceneShotsStorage {
 stage(taskId: string,index: number,bytes: Buffer): void;
 staged(taskId: string,index: number): Buffer;
 /** Durable completion marker, written only after every bounded PNG is complete. */
 complete(task: SceneShotsStorageTask,receipt: SceneShotsReceipt,check: ()=>void): void;
 readReceipt(task: SceneShotsStorageTask): SceneShotsReceipt|null;
 artifact(task: SceneShotsStorageTask,receipt: SceneShotsReceipt,index: number,check: ()=>void,options?: {signal?: AbortSignal}): Promise<Buffer>;
 publish(task: SceneShotsStorageTask,receipt: SceneShotsReceipt,index: number,check: ()=>void,options?: {signal?: AbortSignal}): Promise<ScenePublishedResult>;
 /** Only private temporary PNGs are eligible for cleanup. */
 discard(taskId: string,count: number): void;
}
const failure=(): Error=>Object.assign(new Error('The local storyboard keyframes cannot be stored safely.'),{code:'SCENE_STORAGE_FAILED'});
const digest=(bytes: Buffer): string=>createHash('sha256').update(bytes).digest('hex');
const uuid=(value: unknown): boolean=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const maxBytes=FRAME_LIMITS.resultBytes;
export const scenePublicationOwner=(task: SceneShotsStorageTask): ProjectOutputOwner=>({kind:'scene',id:task.id,requestId:task.requestId,inputHash:task.inputHash});

/** PNGs and the complete batch manifest live in the persistent private temp
 * family. A partial batch never authorizes restart recovery or result ownership. */
export function createSceneShotsStorage(store: {readonly root: string}): SceneShotsStorage {
 const {projectDir:root,tempDir:stagingRoot}=storeDirectories(store),directory=path.join(stagingRoot,'scene-staging'),media=path.join(root,'media');
 const mediaRoot=isProjectStore(store)?projectMediaDirectory(store):root;
 const relative=(file:string):string=>path.relative(root,file).split(path.sep).join('/');
 const readMedia=(file:string,options:Omit<import('@mioon/contracts/private-storage').ReadPrivateFileOptions,'root'>)=>isProjectStore(store)?readProjectMediaFile(store,relative(file),options):readPrivateFile(file,{root,...options});
 const writeMedia=(file:string,bytes:Buffer,options:Omit<import('@mioon/contracts/private-storage').WritePrivateFileOptions,'root'>):void=>{if(isProjectStore(store))writeProjectMediaFileAtomic(store,relative(file),bytes,options);else writePrivateFileAtomic(file,bytes,{root,...options});};
 function syncDirectory(value: string,ownerRoot=mediaRoot): void {
  if(process.platform==='win32'){getWindowsManagedFileIO().syncDirectory(value,{root:ownerRoot,private:!(isProjectStore(store)&&ownerRoot===mediaRoot)});return;}
  const ordinary=isProjectStore(store)&&ownerRoot===mediaRoot;const before=ordinary?lstatSync(value):validateManagedDirectory(value,{root:ownerRoot});let fd;
  try{
   if(!before)throw failure();
   fd=openSync(value,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);
   if(!opened.isDirectory()||before.dev!==opened.dev||before.ino!==opened.ino)throw failure();
   fsyncSync(fd);const after=ordinary?lstatSync(value):validateManagedDirectory(value,{root:ownerRoot});if(!after||after.dev!==opened.dev||after.ino!==opened.ino)throw failure();
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 function stagePath(taskId: string,index: number): string {
  if(!uuid(taskId)||!Number.isSafeInteger(index)||index<0||index>=SCENE_LIMITS.shotsPerTask)throw failure();
  return path.join(directory,`${taskId}-${index}.png`);
 }
 function manifestPath(taskId: string): string {if(!uuid(taskId))throw failure();return path.join(directory,`${taskId}.json`);}
 const finalPath=(assetId: string): string=>{if(!uuid(assetId))throw failure();return path.join(media,`${assetId}.png`);};
 function validateReceipt(task: SceneShotsStorageTask,value: unknown): SceneShotsReceipt {
  const parsed=sceneShotsReceiptSchema.safeParse(value);if(!parsed.success)throw failure();const receipt=parsed.data as SceneShotsReceipt,source=task.snapshot.source,plan=sceneShotPlan(task.snapshot);
  if(receipt.projectId!==task.projectId||receipt.taskId!==task.id||receipt.inputHash!==task.inputHash||receipt.sourceAssetId!==source.assetId||receipt.sourceHash!==source.sha256||
   receipt.probe.width!==source.width||receipt.probe.height!==source.height||receipt.keyframes.length!==plan.length||
   receipt.keyframes.some((entry,index)=>entry.segment!==plan[index]!.segment||entry.sourceFrame!==plan[index]!.sourceFrame))throw failure();
  if(task.stagedReceipt!==undefined&&task.stagedReceipt!==null){let saved: unknown;try{saved=JSON.parse(task.stagedReceipt);}catch{throw failure();}if(canonical(saved)!==canonical(receipt))throw failure();}
  return receipt;
 }
 function readReceipt(task: SceneShotsStorageTask): SceneShotsReceipt|null {
  if(!validateManagedDirectory(directory,{root:stagingRoot,allowMissing:true,private:true}))return null;
  const raw=readPrivateFile(manifestPath(task.id),{root:stagingRoot,allowMissing:true,maxBytes:SCENE_LIMITS.receiptBytes,encoding:'utf8'});if(raw===null)return null;
  let value: unknown;try{value=JSON.parse(String(raw));}catch{throw failure();}return validateReceipt(task,value);
 }
 function stage(taskId: string,index: number,bytes: Buffer): void {
  const file=stagePath(taskId,index);
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxBytes)throw failure();
  if(!validateManagedDirectory(directory,{root:stagingRoot,allowMissing:true,private:true})){ensurePrivateDirectory(directory,{create:true});validateManagedDirectory(directory,{root:stagingRoot,private:true});syncDirectory(stagingRoot,stagingRoot);}
  writePrivateFileAtomic(file,bytes,{root:stagingRoot,maxBytes,replace:false});syncDirectory(directory,stagingRoot);
 }
 function staged(taskId: string,index: number): Buffer {
  const bytes=readPrivateFile(stagePath(taskId,index),{root:stagingRoot,maxBytes});
  if(!Buffer.isBuffer(bytes)||!bytes.length)throw failure();return bytes;
 }
 function complete(task: SceneShotsStorageTask,receipt: SceneShotsReceipt,check: ()=>void): void {
  check();validateReceipt(task,receipt);
  for(const [index,entry] of receipt.keyframes.entries()){check();const bytes=staged(task.id,index);if(bytes.length!==entry.byteLength||digest(bytes)!==entry.sha256)throw failure();}
  check();writePrivateFileAtomic(manifestPath(task.id),canonical(receipt),{root:stagingRoot,maxBytes:SCENE_LIMITS.receiptBytes,replace:false});syncDirectory(directory,stagingRoot);check();
 }
 async function artifact(task: SceneShotsStorageTask,receipt: SceneShotsReceipt,index: number,check: ()=>void,{signal}: {signal?: AbortSignal}={}): Promise<Buffer> {
  check();validateReceipt(task,receipt);const saved=readReceipt(task);if(!saved||canonical(saved)!==canonical(receipt))throw failure();
  const entry=receipt.keyframes[index];if(!entry)throw failure();
  // Do not weaken the single-link private reader after a crash between link
  // publication and registration. The durable publication proves the final.
  const published=isProjectStore(store)?await readPublishedProjectOutput(store,{owner:scenePublicationOwner(task),assetId:entry.assetId},{maxBytes,signal,beforeEffect:check}):null;check();
  const bytes=published??staged(task.id,index);if(bytes.length!==entry.byteLength||digest(bytes)!==entry.sha256)throw failure();return bytes;
 }
 async function publish(task: SceneShotsStorageTask,receipt: SceneShotsReceipt,index: number,check: ()=>void,{signal}: {signal?: AbortSignal}={}): Promise<ScenePublishedResult> {
  const bytes=await artifact(task,receipt,index,check,{signal}),entry=receipt.keyframes[index]!;check();
  if(isProjectStore(store))return publishProjectOutput(store,{owner:scenePublicationOwner(task),assetId:entry.assetId,targetKind:'generated',stageFile:stagePath(task.id,index),mimeType:'image/png',sha256:entry.sha256,sizeBytes:entry.byteLength},{signal,beforeEffect:check});
  const file=finalPath(entry.assetId),existing=readMedia(file,{allowMissing:true,maxBytes});
  if(existing){if(typeof existing==='string'||existing.length!==bytes.length||digest(existing)!==entry.sha256)throw failure();}
  else writeMedia(file,bytes,{maxBytes,replace:false});
  syncDirectory(media);check();return {relativePath:`media/${entry.assetId}.png`,sizeBytes:entry.byteLength};
 }
 function discard(taskId: string,count: number): void {
  if(!validateManagedDirectory(directory,{root:stagingRoot,allowMissing:true,private:true}))return;
  for(let index=0;index<Math.min(count,SCENE_LIMITS.shotsPerTask);index++)removePrivateFile(stagePath(taskId,index),{root:stagingRoot,maxBytes});
 }
 return {stage,staged,complete,readReceipt,artifact,publish,discard};
}
