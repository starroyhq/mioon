import {lstatSync,realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {AppError} from '../../contracts/src/app-error.ts';
import {mediaUnavailableError} from '../../contracts/src/media-reference-errors.ts';
import type {OutsidePathConfirmationStore} from './app-db/stores.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {isFileInDirectory,isInsideRealDirectory} from './media-reference/paths.ts';

/** Pin an L1-prepared candidate while asynchronous probing/hash work runs.
 * Permission is read again at every effect and before registration. The host
 * fence runs outside filesystem error normalization so its exact cancellation
 * or task-denial sentinel remains the causal error. */
export function createPreparedMediaFileFence(store:ProjectStore,file:string,{assetId,outsidePaths,beforeEffect}:
 {assetId:string;outsidePaths:Pick<OutsidePathConfirmationStore,'list'>;beforeEffect:()=>void}):()=>void {
 const owner=():void=>{beforeEffect();if(!isProjectStore(store))throw new AppError('PROJECT_UNAVAILABLE','项目已关闭',409);};
 const location=():{info:BigIntStats;file:string;project:string}=>{
  try{return {info:lstatSync(file,{bigint:true}),file:realpathSync(file),project:realpathSync(store.projectDir)};}
  catch(error){
   const code=error!==null&&typeof error==='object'&&'code' in error?error.code:undefined;
   throw mediaUnavailableError('MEDIA_MISSING',assetId,code==='ENOENT'||code==='ENOTDIR'?'not-found':'no-access');
  }
 };
 owner();const initial=location();
 const fence=():void=>{
  owner();const actual=location(),identity={dev:String(actual.info.dev),ino:String(actual.info.ino)};
  if(!actual.info.isFile()||isProjectFileHeld(identity)||isAppLibraryHeld(identity)||actual.file!==file||actual.project!==initial.project||
   actual.info.dev!==initial.info.dev||actual.info.ino!==initial.info.ino||actual.info.size!==initial.info.size||actual.info.mtimeNs!==initial.info.mtimeNs||actual.info.ctimeNs!==initial.info.ctimeNs)throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ',assetId);
  if(!isInsideRealDirectory(actual.project,file)&&!outsidePaths.list(store.projectId).some(value=>isFileInDirectory(value.directory,file)))throw mediaUnavailableError('MEDIA_OUTSIDE_NOT_CONFIRMED',assetId);
 };
 fence();return fence;
}
