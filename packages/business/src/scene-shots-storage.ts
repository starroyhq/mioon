import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants,lstatSync,openSync,fstatSync,fsyncSync,closeSync} from 'node:fs';
import {ensurePrivateDirectory,validateManagedDirectory,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';
import {FRAME_LIMITS,SCENE_LIMITS} from '@mioon/contracts';
import {storeDirectories} from './store-layout.ts';
import {isProjectStore} from './project-file/store.ts';
import {projectMediaDirectory,readProjectMediaFile,writeProjectMediaFileAtomic,removeProjectMediaFile} from './project-media-storage.ts';

export interface SceneShotsStorage {
 /** One staged PNG per segment position; a retried task never reuses one. */
 stage(taskId: string,index: number,bytes: Buffer): void;
 staged(taskId: string,index: number): Buffer;
 /** Publishes the final media file; an identical existing file is accepted. */
 publish(assetId: string,bytes: Buffer): string;
 discard(taskId: string,count: number): void;
 /** Removes published files that no asset row ever claimed. */
 withdraw(assetIds: readonly string[],claimed: (assetId: string)=>boolean): void;
}
const failure=(): Error=>Object.assign(new Error('The local storyboard keyframes cannot be stored safely.'),{code:'SCENE_STORAGE_FAILED'});
const digest=(bytes: Buffer): string=>createHash('sha256').update(bytes).digest('hex');
const uuid=(value: unknown): boolean=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const maxBytes=FRAME_LIMITS.resultBytes;

/** Transient keyframe staging. Nothing here is recoverable after a restart, so
 * the directory is outside the backup families and every path is derived from
 * a task or asset UUID; reads never create directories. */
export function createSceneShotsStorage(store: {readonly root: string}): SceneShotsStorage {
 const {projectDir:root,tempDir:stagingRoot}=storeDirectories(store),directory=path.join(stagingRoot,'scene-staging'),media=path.join(root,'media');
 const mediaRoot=isProjectStore(store)?projectMediaDirectory(store):root;
 const relative=(file:string):string=>path.relative(root,file).split(path.sep).join('/');
 const readMedia=(file:string,options:Omit<import('@mioon/contracts/private-storage').ReadPrivateFileOptions,'root'>)=>isProjectStore(store)?readProjectMediaFile(store,relative(file),options):readPrivateFile(file,{root,...options});
 const writeMedia=(file:string,bytes:Buffer,options:Omit<import('@mioon/contracts/private-storage').WritePrivateFileOptions,'root'>):void=>{if(isProjectStore(store))writeProjectMediaFileAtomic(store,relative(file),bytes,options);else writePrivateFileAtomic(file,bytes,{root,...options});};
 const removeMedia=(file:string,options:Omit<import('@mioon/contracts/private-storage').RemovePrivateFileOptions,'root'>):void=>{if(isProjectStore(store))removeProjectMediaFile(store,relative(file),options);else removePrivateFile(file,{root,...options});};
 function syncDirectory(value: string,ownerRoot=mediaRoot): void {
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
 const finalPath=(assetId: string): string=>{if(!uuid(assetId))throw failure();return path.join(media,`${assetId}.png`);};
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
 function publish(assetId: string,bytes: Buffer): string {
  const file=finalPath(assetId),existing=readMedia(file,{allowMissing:true,maxBytes});
  if(existing){if(typeof existing==='string'||existing.length!==bytes.length||digest(existing)!==digest(bytes))throw failure();}
  else writeMedia(file,bytes,{maxBytes,replace:false});
  syncDirectory(media);return `media/${assetId}.png`;
 }
 function discard(taskId: string,count: number): void {
  if(!validateManagedDirectory(directory,{root:stagingRoot,allowMissing:true,private:true}))return;
  for(let index=0;index<Math.min(count,SCENE_LIMITS.shotsPerTask);index++)removePrivateFile(stagePath(taskId,index),{root:stagingRoot,maxBytes});
 }
 function withdraw(assetIds: readonly string[],claimed: (assetId: string)=>boolean): void {
  for(const assetId of assetIds)if(!claimed(assetId))removeMedia(finalPath(assetId),{maxBytes});
 }
 return {stage,staged,publish,discard,withdraw};
}
