// Offline backup-specific paths and durable COMPLETE marker publication.
// Shared managed I/O is implemented independently in managed-file-io.ts.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {constants,lstatSync,mkdirSync,openSync,closeSync,fstatSync,fsyncSync,unlinkSync,linkSync} from 'node:fs';
import {WORKSPACE_BACKUP_LIMITS} from '../../contracts/src/workspace-backup.ts';
import {validatePrivateDirectory,readPrivateFile,getWindowsManagedFileIO} from '@mioon/contracts/private-storage';
import type {Stats} from 'node:fs';
import {MANAGED_FILE_IO_MESSAGES,sameNode,sameFile,assertManagedFileIOAvailable as assertBackupStorageAvailable,createNewDirectory,inspectFile,syncDirectory,removeOwnedFile,writeBoundedFile} from './managed-file-io.ts';
// Compatibility for callers of the legacy container; current callers import the leaf.
export {checkCancelled,sameNode,sameFile,assertManagedFileIOAvailable as assertBackupStorageAvailable,checkSeparate,checkedDirectory,checkDirectoryIdentity,createNewDirectory,inspectFile,syncDirectory,removeOwnedFile,streamFile,readJsonFile,writeBoundedFile,scanDirectory,removeOwnedDirectory} from './managed-file-io.ts';
export const BACKUP_IO_LIMITS=Object.freeze({...WORKSPACE_BACKUP_LIMITS,directoryEntries:40000});
const messages=Object.freeze({
 ...MANAGED_FILE_IO_MESSAGES,
 LOCKED:'The workspace has an existing lock. Stop the backend and review the lock before retrying.',
 LOCK_LOST:'The workspace lock changed. The incomplete backup has not been published.',
 NOT_COLD:'The workspace has an uncheckpointed SQLite WAL or journal. Close the backend cleanly before backing up; no sidecar was repaired or deleted.',
 DATABASE_INVALID:'The copied database cannot be safely inspected as a supported workspace.',
 INCOMPLETE:'This directory has no complete supported workspace backup.',
 PUBLICATION_UNCONFIRMED:'Backup publication durability could not be confirmed. Inspect COMPLETE.json before treating this directory as a finished backup.',
});
export function backupError(reason: string): Error{return Object.assign(new Error((messages as Record<string,string>)[reason]||messages.IO),{code:`WORKSPACE_BACKUP_${reason}`});}
export function fail(reason: string): never{throw backupError(reason);}
export function safeBackupError(error: unknown): Error{
 const failure=error as {code?: string};
 if(typeof failure?.code==='string'&&(failure.code.startsWith('WORKSPACE_BACKUP_')||['STORAGE_PRIVATE_REQUIRED','STORAGE_PRIVACY_UNAVAILABLE','RESTORE_BACKUP_UNAVAILABLE'].includes(failure.code)))return error as Error;
 return backupError('IO');
}
export function explicitPath(value: unknown): string{
 assertBackupStorageAvailable();
 if(typeof value!=='string'||!value||value.includes('\0')||!path.isAbsolute(value)||path.resolve(value)!==value)fail('INVALID_PATH');
 return value;
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
