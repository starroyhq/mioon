import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
import {throwIfMediaAborted} from './media-processes.mjs';

export const SUBTITLE_FONT_FILE='mioon-subtitle-cjk-sc-v1.otf';
export const SUBTITLE_FONT_BYTES=16437296;
let resourceDirectory=fileURLToPath(new URL('../resources/subtitles/',import.meta.url)),initialized=false;
const fault=(code,message)=>Object.assign(Error(message),{code});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;

// Called once by the trusted Electron backend bootstrap, never RPC, renderer,
// project data, model tools or environment. Source-mode uses the checked-in dir.
export function initializeSubtitleResources(directory){
 if(initialized||typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0'))throw fault('SUBTITLE_RESOURCE_UNAVAILABLE','Subtitle resources could not be initialized.');
 resourceDirectory=path.resolve(directory);initialized=true;
}
export function validateSubtitleSnapshotProfile(snapshot){
 const cues=snapshot?.timeline?.subtitles?.cues;
 const nonempty=Array.isArray(cues)&&cues.length>0,profile=snapshot?.subtitleProfile;
 if(nonempty){
  if(!profile||typeof profile!=='object'||Array.isArray(profile)||Object.keys(profile).length!==2||profile.profileId!==TIMELINE_SUBTITLE_PROFILE_ID||profile.fontSha256!==TIMELINE_SUBTITLE_FONT_SHA256)
   throw fault('INVALID_TIMELINE_SNAPSHOT','The saved subtitle rendering profile is invalid.');
 }else if(snapshot&&Object.hasOwn(snapshot,'subtitleProfile'))throw fault('INVALID_TIMELINE_SNAPSHOT','The saved subtitle rendering profile is invalid.');
 return nonempty;
}

// Bounded regular-file hashing; there is no whole-font stdout or ASAR read.
// Optionally write the verified bytes to one private render staging file. That
// exact copy is reused for measurement and rendering, eliminating a font TOCTOU.
export async function verifySubtitleFontResource({signal,destination}={}){
 throwIfMediaAborted(signal);
 let source,output;
 try{
  const directory=await lstat(resourceDirectory);
  if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Invalid resource directory');
  const file=path.join(resourceDirectory,SUBTITLE_FONT_FILE),before=await lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==SUBTITLE_FONT_BYTES)throw Error('Invalid font resource');
  source=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  const opened=await source.stat();
  if(!opened.isFile()||!same(before,opened))throw Error('Changed font resource');
  if(destination)output=await open(destination,'wx',0o600);
  const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let bytes=0;
  while(bytes<SUBTITLE_FONT_BYTES){
   throwIfMediaAborted(signal);
   const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,SUBTITLE_FONT_BYTES-bytes),bytes);
   if(!bytesRead)throw Error('Truncated font resource');
   hash.update(buffer.subarray(0,bytesRead));
   if(output){let written=0;while(written<bytesRead){throwIfMediaAborted(signal);const part=await output.write(buffer,written,bytesRead-written,bytes+written);if(!part.bytesWritten)throw Error('Incomplete font copy');written+=part.bytesWritten;}}
   bytes+=bytesRead;
  }
  if((await source.read(buffer,0,1,bytes)).bytesRead||!same(opened,await source.stat())||!same(opened,await lstat(file))||hash.digest('hex')!==TIMELINE_SUBTITLE_FONT_SHA256)throw Error('Changed font resource');
  throwIfMediaAborted(signal);
  return {profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256,bytes};
 }catch(error){
  throwIfMediaAborted(signal);
  if(error.code==='MEDIA_CANCELLED'||error.terminationUnconfirmed)throw error;
  throw fault('SUBTITLE_RESOURCE_UNAVAILABLE','The bundled subtitle font is missing or does not match this rendering profile.');
 }finally{await Promise.all([source?.close(),output?.close()]).catch(()=>{throw fault('SUBTITLE_RESOURCE_UNAVAILABLE','Subtitle resource handles could not be closed.');});}
}
