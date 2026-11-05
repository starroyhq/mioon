import path from 'node:path';
import {calculateWorkspaceScope} from '../../../packages/contracts/src/workspace-scope.ts';
import {validatePrivateDirectory,validateManagedFile,readPrivateFile,writePrivateFileAtomic} from '../../../packages/contracts/src/private-storage.ts';
import type {UiPreferences} from '../../../packages/contracts/src/ui-preferences.ts';

export const DESKTOP_APPEARANCE_CACHE_FILENAME='desktop-appearance-cache-v1.json';
export const DESKTOP_APPEARANCE_CACHE_MAX_BYTES=4096;
export type DesktopAppearanceTheme=UiPreferences['theme'];
export interface DesktopAppearanceSnapshot {readonly appLibraryScope:string;readonly theme:DesktopAppearanceTheme}
export interface DesktopAppearanceCache {
 scope():string|null;
 read():DesktopAppearanceSnapshot|null;
 write(theme:DesktopAppearanceTheme,expectedScope:string,isCurrent:()=>boolean):boolean;
}
export interface DesktopAppearanceCacheStorage {
 validatePrivateDirectory:typeof validatePrivateDirectory;
 validateManagedFile:typeof validateManagedFile;
 readPrivateFile:typeof readPrivateFile;
 writePrivateFileAtomic:typeof writePrivateFileAtomic;
}
interface CacheRecord extends DesktopAppearanceSnapshot {
 readonly version:1;readonly appId:string;readonly channel:'development'|'production';
}
function parse(value:unknown):CacheRecord|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const record=value as Record<string,unknown>,keys=['version','appId','channel','appLibraryScope','theme'];
 if(Object.keys(record).length!==keys.length||!keys.every(key=>Object.hasOwn(record,key))||record.version!==1||
  typeof record.appId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,199}$/u.test(record.appId)||
  typeof record.channel!=='string'||!['development','production'].includes(record.channel)||typeof record.appLibraryScope!=='string'||!/^[a-f0-9]{64}$/u.test(record.appLibraryScope)||
  typeof record.theme!=='string'||!['dark','light','system'].includes(record.theme))return null;
 return record as unknown as CacheRecord;
}
/** A rebuildable native fill hint, separate from authoritative preferences.
 * Reading only stats the application library; it never opens the database. */
export function createDesktopAppearanceCache({root,dataRoot,appId,channel,storage={validatePrivateDirectory,validateManagedFile,readPrivateFile,writePrivateFileAtomic}}:{
 root:string;dataRoot:string;appId:string;channel:'development'|'production';storage?:DesktopAppearanceCacheStorage;
}):DesktopAppearanceCache {
 if(!path.isAbsolute(root)||!path.isAbsolute(dataRoot)||!parse({version:1,appId,channel,appLibraryScope:'0'.repeat(64),theme:'system'}))throw new TypeError('Invalid desktop appearance identity');
 const file=path.join(root,DESKTOP_APPEARANCE_CACHE_FILENAME),databaseFile=path.join(dataRoot,'app-library.db');
 let establishedScope:string|undefined;
 function scope():string|null {
  try{
   const directory=storage.validatePrivateDirectory(dataRoot,{allowMissing:true}),db=storage.validateManagedFile(databaseFile,{root:dataRoot,private:true,allowMissing:true});
   if(!directory||!db)return null;
   const value=calculateWorkspaceScope({root:dataRoot,channel,directory,db});
   if(establishedScope!==undefined&&establishedScope!==value)return null;
   establishedScope=value;return value;
  }catch{return null;}
 }
 function record():{missing:true}|{missing:false;value:CacheRecord|null} {
  const contents=storage.readPrivateFile(file,{root,private:true,allowMissing:true,maxBytes:DESKTOP_APPEARANCE_CACHE_MAX_BYTES});
  if(contents===null)return {missing:true};
  if(!(contents instanceof Uint8Array)||contents.byteLength>DESKTOP_APPEARANCE_CACHE_MAX_BYTES)return {missing:false,value:null};
  try{return {missing:false,value:parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(contents)))};}
  catch{return {missing:false,value:null};}
 }
 const matches=(value:CacheRecord|null,expected:string):value is CacheRecord=>Boolean(value&&value.appId===appId&&value.channel===channel&&value.appLibraryScope===expected);
 return Object.freeze({
  scope,
  read(){
   try{const before=scope();if(!before)return null;const current=record();if(current.missing||!matches(current.value,before)||scope()!==before)return null;return {appLibraryScope:before,theme:current.value.theme};}
   catch{return null;}
  },
  write(theme:DesktopAppearanceTheme,expectedScope:string,isCurrent:()=>boolean){
   try{
    if(!isCurrent()||scope()!==expectedScope||!['dark','light','system'].includes(theme))return false;
    const current=record();
    // Never repair an unsafe, foreign-identity, unknown or malformed entry.
    // A missing hint can be rebuilt after a successful authenticated read.
    if(!current.missing&&!matches(current.value,expectedScope))return false;
    if(!isCurrent()||scope()!==expectedScope)return false;
    if(!current.missing&&current.value!.theme===theme)return true;
    const serialized=JSON.stringify({version:1,appId,channel,appLibraryScope:expectedScope,theme})+'\n';
    storage.writePrivateFileAtomic(file,serialized,{root,maxBytes:DESKTOP_APPEARANCE_CACHE_MAX_BYTES,replace:!current.missing});
    return true;
   }catch{return false;}
  },
 });
}
