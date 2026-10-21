// Offline backup I/O: no following links, no whole-file media buffering and no
// recursive copy. The POSIX policy is shared with backend storage. Same-UID or
// root mutation races remain outside that policy's security boundary.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync,mkdirSync,openSync,closeSync,fstatSync,readSync,writeSync,fsyncSync,unlinkSync,linkSync,opendirSync,rmdirSync} from 'node:fs';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {WORKSPACE_BACKUP_LIMITS} from '../../contracts/src/workspace-backup.ts';
import {assertStoragePrivacyAvailable,validatePrivateDirectory,validateManagedDirectory,validateManagedFile,readPrivateFile,samePrivateStorageIdentity,privateStorageIdentity,getWindowsManagedFileIO} from '@mioon/contracts/private-storage';
import type {Stats} from 'node:fs';
import type {WindowsManagedFileHandle} from '@mioon/contracts/private-storage';

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

export const BACKUP_IO_LIMITS=Object.freeze({...WORKSPACE_BACKUP_LIMITS,directoryEntries:40000});
const messages=Object.freeze({
 INVALID_PATH:'Use explicit canonical absolute source and destination directories that are not nested.',
 DESTINATION_EXISTS:'The backup destination already exists. Choose a new destination; existing contents were not changed.',
 LOCKED:'The workspace has an existing lock. Stop the backend and review the lock before retrying.',
 LOCK_LOST:'The workspace lock changed. The incomplete backup has not been published.',
 NOT_COLD:'The workspace has an uncheckpointed SQLite WAL or journal. Close the backend cleanly before backing up; no sidecar was repaired or deleted.',
 LIMIT:'The workspace or backup exceeds a fixed offline backup safety limit.',
 DATABASE_INVALID:'The copied database cannot be safely inspected as a supported workspace.',
 INCOMPLETE:'This directory has no complete supported workspace backup.',
 CORRUPT:'Backup contents do not match the complete manifest.',
 CHANGED:'A workspace or backup file changed during inspection. No complete backup was published.',
 CANCELLED:'The workspace backup operation was cancelled.',
 PUBLICATION_UNCONFIRMED:'Backup publication durability could not be confirmed. Inspect COMPLETE.json before treating this directory as a finished backup.',
 IO:'The workspace backup operation could not safely complete. Incomplete files may remain in the new destination.',
});
export function backupError(reason: string): Error{return Object.assign(new Error((messages as Record<string,string>)[reason]||messages.IO),{code:`WORKSPACE_BACKUP_${reason}`});}
export function fail(reason: string): never{throw backupError(reason);}
export function checkCancelled(signal: AbortSignal|undefined): void{if(signal?.aborted)fail('CANCELLED');}
export function safeBackupError(error: unknown): Error{
 const failure=error as {code?: string};
 if(typeof failure?.code==='string'&&(failure.code.startsWith('WORKSPACE_BACKUP_')||['STORAGE_PRIVATE_REQUIRED','STORAGE_PRIVACY_UNAVAILABLE','RESTORE_BACKUP_UNAVAILABLE'].includes(failure.code)))return error as Error;
 return backupError('IO');
}
export const sameNode=(a: Stats|null|undefined,b: Stats|null|undefined): boolean=>samePrivateStorageIdentity(a,b);
export const sameFile=(a: Stats|null|undefined,b: Stats|null|undefined): boolean=>sameNode(a,b)&&!!a&&!!b&&(process.platform==='win32'?['size','mtimeMs','ctimeMs','nlink'] as const:['size','mtimeMs','ctimeMs','uid','mode','nlink'] as const).every(key=>a[key]===b[key]);
/** General private-file readiness is insufficient for streaming and durable
 * publication. Windows also requires the complete owned-handle I/O extension. */
export function assertBackupStorageAvailable(): void{
 assertStoragePrivacyAvailable();
 if(process.platform==='win32')getWindowsManagedFileIO();
}
export function explicitPath(value: unknown): string{
 assertBackupStorageAvailable();
 if(typeof value!=='string'||!value||value.includes('\0')||!path.isAbsolute(value)||path.resolve(value)!==value)fail('INVALID_PATH');
 return value;
}
export function checkSeparate(source: string,destination: string): void{
 const nested=(a: string,b: string): boolean=>{const r=path.relative(a,b);return !r||(!r.startsWith(`..${path.sep}`)&&r!=='..'&&!path.isAbsolute(r));};
 if(nested(source,destination)||nested(destination,source))fail('INVALID_PATH');
}
export function checkedDirectory(directory: string,root: string,{private:privateMode=true}: DirectoryOptions={}): Stats|null{
 assertBackupStorageAvailable();
 return validateManagedDirectory(directory,{root,private:privateMode});
}
export function checkDirectoryIdentity(directory: string,root: string,identity: Stats,{private:privateMode=true}: DirectoryOptions={}): void{
 if(!sameNode(identity,checkedDirectory(directory,root,{private:privateMode})))fail('CHANGED');
}
export function createNewDirectory(directory: string,root?: string): Stats{
 assertBackupStorageAvailable();
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
// Destination parents may be ordinary owned/system 0755 directories or trusted
// sticky temporary directories; a newly created destination itself is 0700.
export function createDestination(directory: string): Stats{
 assertBackupStorageAvailable();
 if(process.platform==='win32')return createNewDirectory(directory);
 if(validatePrivateDirectory(directory,{allowMissing:true}))fail('DESTINATION_EXISTS');
 // validatePrivateDirectory checked every existing ancestor up to this leaf.
 // mkdir is non-recursive and fails if its direct parent is absent.
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
export function inspectFile(file: string,root: string,{allowMissing=false,private:privateMode=false,maxBytes=BACKUP_IO_LIMITS.fileBytes}: InspectOptions={}): Stats|null{
 assertBackupStorageAvailable();
 const info=validateManagedFile(file,{root,allowMissing,private:privateMode});
 if(info)validateDescriptor(info,{private:privateMode,maxBytes});
 return info;
}
export function syncDirectory(directory: string,root: string): void{
 assertBackupStorageAvailable();
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
// Validate the parent as an ancestor (0755 or trusted sticky is permitted),
// then bind the fsync handle to that verified inode. Do not weaken root policy.
export function syncDestinationParent(directory: string): void{
 assertBackupStorageAvailable();
 if(process.platform==='win32'){
  validatePrivateDirectory(directory);
  getWindowsManagedFileIO().syncDirectory(path.dirname(directory),{private:false});
  validatePrivateDirectory(directory);return;
 }
 validatePrivateDirectory(directory);
 const parent=path.dirname(directory),before=lstatSync(parent);let fd;
 try{
  fd=openSync(parent,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_DIRECTORY||0));
  const opened=fstatSync(fd);
  if(!opened.isDirectory()||!sameNode(before,opened))fail('CHANGED');
  fsyncSync(fd);validatePrivateDirectory(directory);
  if(!sameNode(opened,lstatSync(parent)))fail('CHANGED');
 }finally{if(fd!==undefined)closeSync(fd);}
}
export function removeOwnedFile(file: string,root: string,identity: Stats|null|undefined): boolean{
 const current=inspectFile(file,root,{allowMissing:true,private:true});
 if(current&&sameFile(current,identity)){
  if(process.platform==='win32')getWindowsManagedFileIO().removeOwnedFile(file,{root,expected:current,maxBytes:BACKUP_IO_LIMITS.fileBytes});
  else unlinkSync(file);
  return true;
 }
 return current===null;
}
export async function streamFile({file,root,destination,destinationRoot,signal,check=()=>{},maxBytes=BACKUP_IO_LIMITS.fileBytes,expected,cleanupOnFailure=false,private:privateMode=false}: StreamFileOptions): Promise<StreamFileResult>{
 assertBackupStorageAvailable();
 checkCancelled(signal);check();
 if(process.platform==='win32')return streamWindowsFile({file,root,destination,destinationRoot,signal,check,maxBytes,expected,cleanupOnFailure,private:privateMode});
 const before=inspectFile(file,root,{private:privateMode,maxBytes})!;
 if(expected&&!sameFile(before,expected))fail('CHANGED');
 let input: number|undefined,output: number|undefined,created: Stats|undefined,savedIdentity: Stats|undefined;
 const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(BACKUP_IO_LIMITS.chunkBytes);let bytes=0;
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
async function streamWindowsFile({file,root,destination,destinationRoot,signal,check=()=>{},maxBytes=BACKUP_IO_LIMITS.fileBytes,expected,cleanupOnFailure=false,private:privateMode=false}: StreamFileOptions): Promise<StreamFileResult>{
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
   checkCancelled(signal);check();const chunk=input.read(BACKUP_IO_LIMITS.chunkBytes);if(!chunk.length)break;
   if(chunk.length>BACKUP_IO_LIMITS.chunkBytes||bytes+chunk.length>maxBytes||bytes+chunk.length>before.size)fail('LIMIT');
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
 assertBackupStorageAvailable();
 if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
 if(bytes.length>maxBytes)fail('LIMIT');
 if(process.platform==='win32'){
  const handle=getWindowsManagedFileIO().openFile(file,{root,private:true,maxBytes,mode:'create'});
  try{
   for(let offset=0;offset<bytes.length;offset+=BACKUP_IO_LIMITS.chunkBytes)handle.write(bytes.subarray(offset,offset+BACKUP_IO_LIMITS.chunkBytes));
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
export function publishMarker(file: string,root: string,bytes: Buffer|Uint8Array,check: ()=>void): Stats{
 assertBackupStorageAvailable();
 if(process.platform==='win32')return publishWindowsMarker(file,root,bytes,check);
 const temporary=path.join(root,`.complete-${randomUUID()}.tmp`);let identity: Stats|undefined,linked=false;
 const removeTemporary=(): void=>{try{const info=lstatSync(temporary);if(identity&&sameNode(identity,info)&&info.isFile()&&info.uid===identity.uid)unlinkSync(temporary);}catch(error){if((error as {code?: unknown}).code!=='ENOENT')throw error;}};
 try{
  identity=writeBoundedFile(temporary,root,bytes,4096);check();
  if(!sameFile(identity,inspectFile(temporary,root,{private:true,maxBytes:4096})))fail('CHANGED');
  linkSync(temporary,file);linked=true;removeTemporary();
  const published=inspectFile(file,root,{private:true,maxBytes:4096})!;
  if(!sameNode(identity,published)||identity!.size!==published.size||identity!.mtimeMs!==published.mtimeMs)fail('CHANGED');
  // Cancellation after this final checked publication begins does not undo a
  // successfully durable marker. The operation has committed.
  syncDirectory(root,root);return published;
 }catch(error){
  if(linked){
   try{
    removeTemporary();
    const current=inspectFile(file,root,{allowMissing:true,private:true,maxBytes:4096});
    if(current){
     // Never assign ownership from the newly observed pathname. Only the inode
     // we created, with our unchanged bytes, may be removed during rollback.
     if(!sameNode(identity,current)||identity!.size!==current.size||identity!.mtimeMs!==current.mtimeMs||!(readPrivateFile(file,{root,maxBytes:4096}) as Buffer).equals(bytes))fail('CHANGED');
     if(!removeOwnedFile(file,root,current))fail('CHANGED');
    }
    syncDirectory(root,root);
   }catch{fail('PUBLICATION_UNCONFIRMED');}
  }
  throw error;
 }finally{if(identity){try{removeTemporary();}catch{}}}
}
function publishWindowsMarker(file:string,root:string,bytes:Buffer|Uint8Array,check:()=>void):Stats{
 const temporary=path.join(root,`.complete-${randomUUID()}.tmp`),io=getWindowsManagedFileIO();let identity:Stats|undefined,attempted=false;
 try{
  identity=writeBoundedFile(temporary,root,bytes,4096);check();
  if(!sameFile(identity,inspectFile(temporary,root,{private:true,maxBytes:4096})))fail('CHANGED');
  attempted=true;const final=io.renameNoReplace(temporary,file,{root,expected:identity});
  if(!sameNode(identity,final)||identity.size!==final.size||identity.mtimeMs!==final.mtimeMs)fail('CHANGED');
  // Rename preserves single-link ownership; the containing directory must be
  // durably flushed before COMPLETE can acknowledge a committed backup.
  syncDirectory(root,root);return final;
 }catch(error){
  if(attempted&&(error as {reason?:unknown}).reason!=='ALREADY_EXISTS'){try{
   const current=inspectFile(file,root,{allowMissing:true,private:true,maxBytes:4096});
   if(current){
    if(!sameNode(identity,current)||identity!.size!==current.size||identity!.mtimeMs!==current.mtimeMs||!(readPrivateFile(file,{root,maxBytes:4096}) as Buffer).equals(bytes))fail('CHANGED');
    if(!removeOwnedFile(file,root,current))fail('CHANGED');
   }
   syncDirectory(root,root);
  }catch{fail('PUBLICATION_UNCONFIRMED');}}
  throw error;
 }finally{if(identity){try{removeOwnedFile(temporary,root,identity);}catch{}}}
}

export async function scanDirectory(directory: string,root: string,{signal,check=()=>{},budget,private:privateMode=false,visit}: ScanDirectoryOptions): Promise<void>{
 assertBackupStorageAvailable();
 if(process.platform==='win32'){
  const before=validateManagedDirectory(directory,{root,allowMissing:true,private:privateMode});if(!before)return;
  const handle=getWindowsManagedFileIO().openDirectory(directory,{root,private:privateMode});
  try{
   if(!sameNode(before,handle.metadata()))fail('CHANGED');let name:string|null;
   while((name=handle.next())!==null){checkCancelled(signal);check();if(++budget.count>BACKUP_IO_LIMITS.directoryEntries)fail('LIMIT');await visit(name);if(budget.count%128===0)await yieldIO();}
   if(!sameNode(before,handle.metadata()))fail('CHANGED');
  }finally{handle.close();}
  checkDirectoryIdentity(directory,root,before,{private:privateMode});return;
 }
 const before=validateManagedDirectory(directory,{root,allowMissing:true,private:privateMode});
 if(!before)return;
 const handle=opendirSync(directory);let entry;
 try{
  while((entry=handle.readSync())){
   checkCancelled(signal);check();if(++budget.count>BACKUP_IO_LIMITS.directoryEntries)fail('LIMIT');
   await visit(entry.name);
   if(budget.count%128===0)await yieldIO();
  }
 }finally{handle.closeSync();}
 checkDirectoryIdentity(directory,root,before,{private:privateMode});
}
export function removeOwnedDirectory(directory: string,root: string,identity: Stats): void{
 assertBackupStorageAvailable();
 if(process.platform==='win32'){getWindowsManagedFileIO().removeOwnedDirectory(directory,{root,expected:identity});return;}
 checkDirectoryIdentity(directory,root,identity);rmdirSync(directory);
}
