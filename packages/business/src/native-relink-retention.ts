import {readdirSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {NATIVE_ASSET_MEDIA_LIMITS} from '../../contracts/src/asset-media-native.ts';
import {ensurePrivateDirectory,validatePrivateDirectory,validateManagedFile,writePrivateFileAtomic,removePrivateFile} from '../../contracts/src/private-storage.ts';

export interface NativeRelinkRetention {
 readonly directory:string;
 admit(writes:readonly {name:string;bytes:string}[]):void;
 write(name:string,bytes:string):void;
 remove(name:string):void;
 usage():{entries:number;bytes:number};
}
const MAX_FILE_BYTES=8*1024*1024;
function limited():never{throw new AppError('ASSET_MEDIA_NATIVE_RETENTION_LIMIT','原生素材操作的保留证据已满，请先核对未完成操作',507);}

/** One metadata-only startup inventory; subsequent synchronous writes account
 * their exact replacement delta. Unknown/accepted files are never evicted to
 * make room. The cap counts evidence files, conservatively bounding operations
 * too (a normal completed apply retains three files). */
export function createNativeRelinkRetention(directory:string):NativeRelinkRetention{
 const sizes=new Map<string,number>();let total=0,writeUncertain=false;
 if(validatePrivateDirectory(directory,{allowMissing:true})){
  for(const name of readdirSync(directory)){
   const info=validateManagedFile(path.join(directory,name),{root:directory,private:true});
   if(info){sizes.set(name,info.size);total+=info.size;}
  }
 }
 const file=(name:string)=>{
  if(!name||path.basename(name)!==name||name==='.'||name==='..')throw new TypeError('A fixed native evidence filename is required');
  return path.join(directory,name);
 };
 const reconcile=(name:string):number=>{
  const target=file(name),root=validatePrivateDirectory(directory,{allowMissing:true});
  const actual=root?validateManagedFile(target,{root:directory,private:true,allowMissing:true}):null;
  const old=sizes.get(name);if(old!==undefined){total-=old;sizes.delete(name);}
  if(actual){sizes.set(name,actual.size);total+=actual.size;}return actual?.size??0;
 };
 const admit=(writes:readonly {name:string;bytes:string}[])=>{
  if(writeUncertain)limited();
  const planned=new Map(writes.map(value=>[value.name,value.bytes]));
  for(const name of planned.keys())reconcile(name);
  let entries=sizes.size,next=total;
  for(const [name,bytes]of planned){const length=Buffer.byteLength(bytes);if(length>MAX_FILE_BYTES)limited();if(!sizes.has(name))entries++;next+=length-(sizes.get(name)??0);}
  if(entries>NATIVE_ASSET_MEDIA_LIMITS.retainedEntries||next>NATIVE_ASSET_MEDIA_LIMITS.retainedBytes)limited();
 };
 return {directory,admit,usage:()=>({entries:sizes.size,bytes:total}),
  write(name,bytes){
   const target=file(name);admit([{name,bytes}]);
   ensurePrivateDirectory(directory,{create:true});
   try{writePrivateFileAtomic(target,bytes,{root:directory,maxBytes:MAX_FILE_BYTES});}
   catch(error){writeUncertain=true;throw error;}
   finally{try{reconcile(name);}catch(error){writeUncertain=true;throw error;}}
  },
  remove(name){
   const target=file(name);if(!validatePrivateDirectory(directory,{allowMissing:true}))return;
   try{removePrivateFile(target,{root:directory,maxBytes:MAX_FILE_BYTES});}finally{reconcile(name);}
  },
 };
}
