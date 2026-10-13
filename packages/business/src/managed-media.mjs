import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {validateManagedFile} from '@mioon/contracts/private-storage';
import {throwIfMediaAborted} from './media-processes.mjs';
import {checkMediaEffect} from './media-runtime.mjs';

const fault=code=>Object.assign(new Error('The managed media source cannot be verified safely.'),{code});
export const sameManagedFile=(a,b)=>Boolean(a&&b&&['dev','ino','size','mtimeMs','ctimeMs'].every(key=>a[key]===b[key]));
// Validate every ancestor and the exact regular, single-link owner-controlled
// leaf. This never repairs permissions or follows a symlink into managed media.
export function validateManagedSource(root,asset,{maxBytes=Infinity}={}){
 const relative=asset?.relativePath;
 if(typeof relative!=='string'||relative.length>4096||relative.includes('\0')||relative.includes('\\')||path.isAbsolute(relative)||
  relative.split('/').some(part=>!part||part==='.'||part==='..')||!relative.startsWith('media/'))throw fault('MANAGED_SOURCE_INVALID');
 const file=path.resolve(root,relative),media=path.join(root,'media');
 if(!file.startsWith(media+path.sep))throw fault('MANAGED_SOURCE_INVALID');
 let info;try{info=validateManagedFile(file,{root});}catch{throw fault('MANAGED_SOURCE_INVALID');}
 if(info.size>maxBytes)throw fault('MANAGED_SOURCE_LIMIT');
 return {file,info};
}

// Streaming SHA reads the descriptor opened with NOFOLLOW/NONBLOCK, with exact
// descriptor and pathname identity checks before and after. Same-UID/root may
// still race a decoder's pathname-only open; this is not a decoder sandbox.
export async function verifiedManagedHash(root,asset,{signal,expected,maxBytes=Infinity,onBytes,beforeEffect}={}){
 // Optional trusted synchronous gate. Keep its first error outside the legacy
 // managed-error sanitization so revocation cannot become a misleading read error.
 let effectFailure;
 const effect=()=>{if(beforeEffect===undefined)return;try{checkMediaEffect(beforeEffect,signal);}catch(error){effectFailure??=error;throw effectFailure;}};
 effect();throwIfMediaAborted(signal);
 const source=validateManagedSource(root,asset,{maxBytes});
 if(expected&&!sameManagedFile(source.info,expected))throw fault('MANAGED_SOURCE_CHANGED');
 let file;
 try{
  effect();file=await open(source.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);effect();
  const first=await file.stat();effect();throwIfMediaAborted(signal);
  if(!first.isFile()||!sameManagedFile(source.info,first))throw fault('MANAGED_SOURCE_CHANGED');
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let bytes=0;
  for(;;){
   effect();throwIfMediaAborted(signal);const read=await file.read(buffer,0,buffer.length,null);effect();throwIfMediaAborted(signal);
   if(!read.bytesRead)break;
   bytes+=read.bytesRead;if(bytes>maxBytes||bytes>first.size)throw fault('MANAGED_SOURCE_CHANGED');
   onBytes?.(read.bytesRead);hash.update(buffer.subarray(0,read.bytesRead));
  }
  effect();const after=await file.stat();effect();throwIfMediaAborted(signal);const current=validateManagedSource(root,asset,{maxBytes});
  const sha256=hash.digest('hex');
  if(bytes!==first.size||!sameManagedFile(first,after)||!sameManagedFile(first,current.info)||sha256!==asset.sha256)throw fault('MANAGED_SOURCE_CHANGED');
  return {file:source.file,info:after,sha256,sizeBytes:bytes};
 }catch(error){if(effectFailure)throw effectFailure;if(error.code?.startsWith('MANAGED_')||error.code==='PREFLIGHT_BUDGET')throw error;throwIfMediaAborted(signal);throw fault('MANAGED_SOURCE_INVALID');}
 // Closing is mandatory even after revocation. Its await is fenced too.
 finally{
  if(beforeEffect===undefined)await file?.close();
  else{
   let closeFailure;try{await file?.close();}catch(error){closeFailure=error;}
   // A rejected close must not erase revocation, nor skip its final gate.
   effect();if(effectFailure)throw effectFailure;if(closeFailure)throw closeFailure;
  }
 }
}
