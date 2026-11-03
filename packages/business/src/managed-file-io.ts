// Managed file I/O: no following links, recursive copy or whole-media buffering.
// The private-storage policy and native Windows owned handles remain authoritative.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants,mkdirSync,openSync,closeSync,fstatSync,readSync,writeSync,fsyncSync,unlinkSync,opendirSync,rmdirSync} from 'node:fs';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {assertStoragePrivacyAvailable,validatePrivateDirectory,validateManagedDirectory,validateManagedFile,readPrivateFile,samePrivateStorageIdentity,privateStorageIdentity,getWindowsManagedFileIO} from '@mioon/contracts/private-storage';
import type {Stats} from 'node:fs';
import type {WindowsManagedFileHandle} from '@mioon/contracts/private-storage';

export const MANAGED_FILE_IO_LIMITS=Object.freeze({fileBytes:8*1024*1024*1024,chunkBytes:1024*1024,directoryEntries:40000});
// Existing callers rely on these exact messages/codes. Keep that vocabulary
// while moving I/O ownership out of the legacy backup container.
export const MANAGED_FILE_IO_MESSAGES=Object.freeze({
 INVALID_PATH:'Use explicit canonical absolute source and destination directories that are not nested.',
 DESTINATION_EXISTS:'The backup destination already exists. Choose a new destination; existing contents were not changed.',
 LIMIT:'The workspace or backup exceeds a fixed offline backup safety limit.',
 CORRUPT:'Backup contents do not match the complete manifest.',
 CHANGED:'A workspace or backup file changed during inspection. No complete backup was published.',
 CANCELLED:'The workspace backup operation was cancelled.',
 IO:'The workspace backup operation could not safely complete. Incomplete files may remain in the new destination.',
});
export function managedFileIOError(reason:string):Error{return Object.assign(new Error((MANAGED_FILE_IO_MESSAGES as Record<string,string>)[reason]||MANAGED_FILE_IO_MESSAGES.IO),{code:`WORKSPACE_BACKUP_${reason}`});}
const fail=(reason:string):never=>{throw managedFileIOError(reason);};


interface DirectoryOptions {private?: boolean}
interface InspectOptions extends DirectoryOptions {allowMissing?: boolean;maxBytes?: number}
interface DescriptorOptions {private: boolean;maxBytes: number}
interface StreamFileOptions {
 file: string;root: string;destination?: string;destinationRoot?: string;signal?: AbortSignal;
 check?: ()=>void;maxBytes?: number;expected?: Stats;cleanupOnFailure?: boolean;private?: boolean;
}
interface StreamFileResult {bytes: number;sha256: string;identity: Stats;savedIdentity: Stats|undefined}
interface ReadJsonOptions {allowMissing?: boolean}
interface ReadJsonResult {raw: Buffer;value: unknown}
interface ScanDirectoryOptions {signal?: AbortSignal;check?: ()=>void;budget: {count: number};private?: boolean;visit: (name: string)=>Promise<void>|void}
export function checkCancelled(signal: AbortSignal|undefined): void{if(signal?.aborted)fail('CANCELLED');}
export const sameNode=(a: Stats|null|undefined,b: Stats|null|undefined): boolean=>samePrivateStorageIdentity(a,b);
export const sameFile=(a: Stats|null|undefined,b: Stats|null|undefined): boolean=>sameNode(a,b)&&!!a&&!!b&&(process.platform==='win32'?['size','mtimeMs','ctimeMs','nlink'] as const:['size','mtimeMs','ctimeMs','uid','mode','nlink'] as const).every(key=>a[key]===b[key]);
/** General private-file readiness is insufficient for streaming and durable
 * publication. Windows also requires the complete owned-handle I/O extension. */
export function assertManagedFileIOAvailable(): void{
 assertStoragePrivacyAvailable();
 if(process.platform==='win32')getWindowsManagedFileIO();
}
export function checkSeparate(source: string,destination: string): void{
 const nested=(a: string,b: string): boolean=>{const r=path.relative(a,b);return !r||(!r.startsWith(`..${path.sep}`)&&r!=='..'&&!path.isAbsolute(r));};
 if(nested(source,destination)||nested(destination,source))fail('INVALID_PATH');
}
export function checkedDirectory(directory: string,root: string,{private:privateMode=true}: DirectoryOptions={}): Stats|null{
 assertManagedFileIOAvailable();
 return validateManagedDirectory(directory,{root,private:privateMode});
}
export function checkDirectoryIdentity(directory: string,root: string,identity: Stats,{private:privateMode=true}: DirectoryOptions={}): void{
 if(!sameNode(identity,checkedDirectory(directory,root,{private:privateMode})))fail('CHANGED');
}
export function createNewDirectory(directory: string,root?: string): Stats{
 assertManagedFileIOAvailable();
 if(process.platform==='win32'){
  try{return getWindowsManagedFileIO().createDirectoryNew(directory,{root});}
  catch(error){if((error as {reason?:unknown}).reason==='ALREADY_EXISTS')fail('DESTINATION_EXISTS');throw error;}
 }
 if(root)validateManagedDirectory(path.dirname(directory),{root,private:true});
 else{
  // Existing ancestors are checked, never repaired. Only the requested leaf is
  // created, avoiding surprise directory trees and destination reuse.
  if(validatePrivateDirectory(directory,{allowMissing:true}))fail('DESTINATION_EXISTS');
  validateManagedDirectory(path.dirname(directory),{root:path.dirname(directory),private:false});
 }
 try{mkdirSync(directory,{mode:0o700});}catch(error){if((error as {code?: unknown}).code==='EEXIST')fail('DESTINATION_EXISTS');throw error;}
 return validatePrivateDirectory(directory)!;
}
function validateDescriptor(info: Stats,{private:privateMode,maxBytes}: DescriptorOptions): Stats{
 if(process.platform==='win32'){
  // Only native-validated metadata has a full Windows identity. uid/mode and
  // Node's lossy dev/ino values are never substituted for the ACL/handle proof.
  privateStorageIdentity(info);
  if(!info.isFile()||info.nlink!==1)fail('CHANGED');
 }else if(!info.isFile()||info.uid!==process.getuid!()||info.nlink!==1||info.mode&(privateMode?0o077:0o022))fail('CHANGED');
 if(!Number.isSafeInteger(info.size)||info.size<0||info.size>maxBytes)fail('LIMIT');
 return info;
}
export function inspectFile(file: string,root: string,{allowMissing=false,private:privateMode=false,maxBytes=MANAGED_FILE_IO_LIMITS.fileBytes}: InspectOptions={}): Stats|null{
 assertManagedFileIOAvailable();
 const info=validateManagedFile(file,{root,allowMissing,private:privateMode});
 if(info)validateDescriptor(info,{private:privateMode,maxBytes});
 return info;
}
export function syncDirectory(directory: string,root: string): void{
 assertManagedFileIOAvailable();
 if(process.platform==='win32'){getWindowsManagedFileIO().syncDirectory(directory,{root,private:true});return;}
 const before=validateManagedDirectory(directory,{root,private:true});let fd;
 try{
  fd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_DIRECTORY||0));
  const opened=fstatSync(fd);
  if(!opened.isDirectory()||!sameNode(before,opened))fail('CHANGED');
  fsyncSync(fd);
  checkDirectoryIdentity(directory,root,opened);
 }finally{if(fd!==undefined)closeSync(fd);}
}
export function removeOwnedFile(file: string,root: string,identity: Stats|null|undefined): boolean{
 const current=inspectFile(file,root,{allowMissing:true,private:true});
 if(current&&sameFile(current,identity)){
  if(process.platform==='win32')getWindowsManagedFileIO().removeOwnedFile(file,{root,expected:current,maxBytes:MANAGED_FILE_IO_LIMITS.fileBytes});
  else unlinkSync(file);
  return true;
 }
 return current===null;
}
export async function streamFile({file,root,destination,destinationRoot,signal,check=()=>{},maxBytes=MANAGED_FILE_IO_LIMITS.fileBytes,expected,cleanupOnFailure=false,private:privateMode=false}: StreamFileOptions): Promise<StreamFileResult>{
 assertManagedFileIOAvailable();
 checkCancelled(signal);check();
 if(process.platform==='win32')return streamWindowsFile({file,root,destination,destinationRoot,signal,check,maxBytes,expected,cleanupOnFailure,private:privateMode});
 const before=inspectFile(file,root,{private:privateMode,maxBytes})!;
 if(expected&&!sameFile(before,expected))fail('CHANGED');
 let input: number|undefined,output: number|undefined,created: Stats|undefined,savedIdentity: Stats|undefined;
 const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(MANAGED_FILE_IO_LIMITS.chunkBytes);let bytes=0;
 try{
  input=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_NONBLOCK||0));
  const opened=validateDescriptor(fstatSync(input),{private:privateMode,maxBytes});
  if(!sameFile(before,opened))fail('CHANGED');
  if(destination){
   validateManagedDirectory(path.dirname(destination),{root:destinationRoot,private:true});
   output=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   created=validateDescriptor(fstatSync(output),{private:true,maxBytes});
  }
  for(;;){
   checkCancelled(signal);check();
   const count=readSync(input,buffer,0,buffer.length,bytes);
   if(!count)break;
   if(bytes+count>maxBytes||bytes+count>before.size)fail('LIMIT');
   const chunk=buffer.subarray(0,count);hash.update(chunk);
   if(output!==undefined){let written=0;while(written<count){const n=writeSync(output,chunk,written,count-written,bytes+written);if(!n)fail('IO');written+=n;}}
   bytes+=count;await yieldIO();
  }
  checkCancelled(signal);check();
  if(bytes!==before.size||!sameFile(before,validateDescriptor(fstatSync(input),{private:privateMode,maxBytes}))||!sameFile(before,inspectFile(file,root,{private:privateMode,maxBytes})))fail('CHANGED');
  if(output!==undefined){
   fsyncSync(output);
   const saved=validateDescriptor(fstatSync(output),{private:true,maxBytes});savedIdentity=saved;
   if(saved.size!==bytes||!sameNode(created,saved)||!sameFile(saved,inspectFile(destination as string,destinationRoot as string,{private:true,maxBytes})))fail('CHANGED');
  }
  return {bytes,sha256:hash.digest('hex'),identity:before,savedIdentity};
 }catch(error){
  if(cleanupOnFailure&&output!==undefined&&created){
   try{
    const current=validateDescriptor(fstatSync(output),{private:true,maxBytes});
    if(sameNode(created,current)){closeSync(output);output=undefined;removeOwnedFile(destination as string,destinationRoot as string,current);}
   }catch{} // Never remove an unverified replacement or unknown file.
  }
  throw error;
 }finally{if(input!==undefined)closeSync(input);if(output!==undefined)closeSync(output);}
}
async function streamWindowsFile({file,root,destination,destinationRoot,signal,check=()=>{},maxBytes=MANAGED_FILE_IO_LIMITS.fileBytes,expected,cleanupOnFailure=false,private:privateMode=false}: StreamFileOptions): Promise<StreamFileResult>{
 const io=getWindowsManagedFileIO(),before=inspectFile(file,root,{private:privateMode,maxBytes})!;
 if(expected&&!sameFile(before,expected))fail('CHANGED');
 if(destination&&!destinationRoot)fail('INVALID_PATH');
 let input:WindowsManagedFileHandle|undefined,output:WindowsManagedFileHandle|undefined,created:Stats|undefined,savedIdentity:Stats|undefined;
 const hash=createHash('sha256');let bytes=0;
 try{
  input=io.openFile(file,{root,private:privateMode,maxBytes,mode:'read',expected:before});
  if(!sameFile(before,validateDescriptor(input.metadata(),{private:privateMode,maxBytes})))fail('CHANGED');
  if(destination){output=io.openFile(destination,{root:destinationRoot!,private:true,maxBytes,mode:'create'});created=validateDescriptor(output.metadata(),{private:true,maxBytes});}
  for(;;){
   checkCancelled(signal);check();const chunk=input.read(MANAGED_FILE_IO_LIMITS.chunkBytes);if(!chunk.length)break;
   if(chunk.length>MANAGED_FILE_IO_LIMITS.chunkBytes||bytes+chunk.length>maxBytes||bytes+chunk.length>before.size)fail('LIMIT');
   hash.update(chunk);output?.write(chunk);bytes+=chunk.length;await yieldIO();
  }
  checkCancelled(signal);check();
  if(bytes!==before.size||!sameFile(before,validateDescriptor(input.metadata(),{private:privateMode,maxBytes}))||!sameFile(before,inspectFile(file,root,{private:privateMode,maxBytes})))fail('CHANGED');
  if(output){
   output.flush();savedIdentity=validateDescriptor(output.metadata(),{private:true,maxBytes});
   if(savedIdentity.size!==bytes||!sameNode(created,savedIdentity)||!sameFile(savedIdentity,inspectFile(destination!,destinationRoot!,{private:true,maxBytes})))fail('CHANGED');
  }
  return {bytes,sha256:hash.digest('hex'),identity:before,savedIdentity};
 }catch(error){
  if(cleanupOnFailure&&output&&created){try{
   const current=validateDescriptor(output.metadata(),{private:true,maxBytes});
   if(sameNode(created,current)){output.close();output=undefined;removeOwnedFile(destination!,destinationRoot!,current);}
  }catch{} /* An unverified replacement is never removed. */}
  throw error;
 }finally{input?.close();output?.close();}
}
export function readJsonFile(file: string,root: string,maxBytes: number,{allowMissing=false}: ReadJsonOptions={}): ReadJsonResult|null{
 const raw=readPrivateFile(file,{root,maxBytes,allowMissing,private:true}) as Buffer;
 if(raw===null)return null;
 let value;try{value=JSON.parse(raw.toString('utf8'));}catch{fail('CORRUPT');}
 return {raw,value};
}
export function writeBoundedFile(file: string,root: string,bytes: Buffer|Uint8Array,maxBytes: number): Stats{
 assertManagedFileIOAvailable();
 if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
 if(bytes.length>maxBytes)fail('LIMIT');
 if(process.platform==='win32'){
  const handle=getWindowsManagedFileIO().openFile(file,{root,private:true,maxBytes,mode:'create'});
  try{
   for(let offset=0;offset<bytes.length;offset+=MANAGED_FILE_IO_LIMITS.chunkBytes)handle.write(bytes.subarray(offset,offset+MANAGED_FILE_IO_LIMITS.chunkBytes));
   handle.flush();const saved=validateDescriptor(handle.metadata(),{private:true,maxBytes});
   if(saved.size!==bytes.length||!sameFile(saved,inspectFile(file,root,{private:true,maxBytes})))fail('CHANGED');return saved;
  }finally{handle.close();}
 }
 validateManagedDirectory(path.dirname(file),{root,private:true});
 let fd;try{
  fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)fail('IO');offset+=n;}
  fsyncSync(fd);
  const info=validateDescriptor(fstatSync(fd),{private:true,maxBytes});
  if(info.size!==bytes.length||!sameFile(info,inspectFile(file,root,{private:true,maxBytes})))fail('CHANGED');
  return info;
 }finally{if(fd!==undefined)closeSync(fd);}
}

export async function scanDirectory(directory: string,root: string,{signal,check=()=>{},budget,private:privateMode=false,visit}: ScanDirectoryOptions): Promise<void>{
 assertManagedFileIOAvailable();
 if(process.platform==='win32'){
  const before=validateManagedDirectory(directory,{root,allowMissing:true,private:privateMode});if(!before)return;
  const handle=getWindowsManagedFileIO().openDirectory(directory,{root,private:privateMode});
  try{
   if(!sameNode(before,handle.metadata()))fail('CHANGED');let name:string|null;
   while((name=handle.next())!==null){checkCancelled(signal);check();if(++budget.count>MANAGED_FILE_IO_LIMITS.directoryEntries)fail('LIMIT');await visit(name);if(budget.count%128===0)await yieldIO();}
   if(!sameNode(before,handle.metadata()))fail('CHANGED');
  }finally{handle.close();}
  checkDirectoryIdentity(directory,root,before,{private:privateMode});return;
 }
 const before=validateManagedDirectory(directory,{root,allowMissing:true,private:privateMode});
 if(!before)return;
 const handle=opendirSync(directory);let entry;
 try{
  while((entry=handle.readSync())){
   checkCancelled(signal);check();if(++budget.count>MANAGED_FILE_IO_LIMITS.directoryEntries)fail('LIMIT');
   await visit(entry.name);
   if(budget.count%128===0)await yieldIO();
  }
 }finally{handle.closeSync();}
 checkDirectoryIdentity(directory,root,before,{private:privateMode});
}
export function removeOwnedDirectory(directory: string,root: string,identity: Stats): void{
 assertManagedFileIOAvailable();
 if(process.platform==='win32'){getWindowsManagedFileIO().removeOwnedDirectory(directory,{root,expected:identity});return;}
 checkDirectoryIdentity(directory,root,identity);rmdirSync(directory);
}
