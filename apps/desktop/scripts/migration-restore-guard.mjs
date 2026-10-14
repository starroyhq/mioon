// Legacy migration accepts readable owned fixture roots (including0755), unlike
// backup's0700 workspace roots. Keep that existing input policy, but inspect a
// private streamed copy before the requested destination exists. No source SQL.
// Preserve legacy size acceptance: one1MiB transfer buffer, temporary disk
// proportional to the original database. This is not backup's512MiB limit.
import path from 'node:path';
import {tmpdir} from 'node:os';
import {constants,lstatSync,realpathSync,openSync,closeSync,fstatSync,readSync,writeSync,fsyncSync} from 'node:fs';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {assertStoragePrivacyAvailable,createPrivateTemporaryDirectory,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {detectCurrentWorkspaceRestoreEvidence} from '@mioon/business/db';
import {sameFile,sameNode,inspectFile,removeOwnedFile,removeOwnedDirectory} from '@mioon/business/workspace-backup-storage';

const refuse=()=>Object.assign(new Error('Restored working branches cannot use legacy migration. Keep the original backup and use the dedicated restore workflow with a new destination.'),{code:'RESTORE_MIGRATION_UNAVAILABLE'});
const changed=()=>Object.assign(new Error('The source database changed while checking migration eligibility.'),{code:'MIGRATION_SOURCE_CHANGED'});
function cold(file){
 for(const target of [path.join(path.dirname(file),'server.lock'),file+'-wal',file+'-journal']){
  let info;try{info=lstatSync(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(target.endsWith('server.lock')||!info.isFile()||info.isSymbolicLink()||info.size)throw changed();
 }
}
function sourceFile(file){
 const info=lstatSync(file);
 if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.nlink!==1||(info.mode&0o022)||!Number.isSafeInteger(info.size)||info.size<16)throw changed();
 return info;
}
export async function withOrdinaryMigrationSource(file,consume){
 assertStoragePrivacyAvailable();
 cold(file);
 const before=sourceFile(file),directory=createPrivateTemporaryDirectory(realpathSync(tmpdir()),'mioon-migration-profile-'),directoryIdentity=validatePrivateDirectory(directory);
 const candidate=path.join(directory,'profile.sqlite');let input,output,db,created,error,result;const owned=new Map();
 try{
  input=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_NONBLOCK||0));
  if(!sameFile(before,fstatSync(input)))throw changed();
  output=openSync(candidate,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=fstatSync(output);
  const buffer=Buffer.allocUnsafe(1024*1024);let offset=0;
  while(offset<before.size){
   const count=readSync(input,buffer,0,Math.min(buffer.length,before.size-offset),offset);if(!count)throw changed();
   let written=0;while(written<count){const n=writeSync(output,buffer,written,count-written,offset+written);if(!n)throw changed();written+=n;}
   offset+=count;await yieldIO();cold(file);
  }
  if(!sameFile(before,fstatSync(input))||!sameFile(before,sourceFile(file)))throw changed();
  fsyncSync(output);closeSync(output);output=undefined;closeSync(input);input=undefined;
  const ready=inspectFile(candidate,directory,{private:true,maxBytes:before.size});if(!sameNode(created,ready)||ready.size!==before.size)throw changed();owned.set(candidate,ready);
  db=new DatabaseSync(candidate,{readOnly:true,enableForeignKeyConstraints:false,enableDoubleQuotedStringLiterals:false});
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  if(detectCurrentWorkspaceRestoreEvidence(db))throw refuse();
  const check=()=>{cold(file);if(!sameFile(before,sourceFile(file))||!sameFile(ready,inspectFile(candidate,directory,{private:true,maxBytes:before.size})))throw changed();};
  // The consumer uses this verified copy, never reopens the original for copy.
  // Close SQLite first; the copy remains private until consumer settlement.
  for(const suffix of ['-wal','-shm','-journal']){const sidecar=inspectFile(candidate+suffix,directory,{allowMissing:true,private:true,maxBytes:64*1024*1024});if(sidecar)owned.set(candidate+suffix,sidecar);}
  db.close();db=undefined;check();
  result=await consume(Object.freeze({file:candidate,check}));check();
 }catch(cause){error=cause;}
 finally{
  try{
   // Match the shared disposable-copy ownership policy: fixed SQLite sidecars
   // are recorded only while this connection owns this private directory.
   if(db)for(const suffix of ['-wal','-shm','-journal']){const sidecar=inspectFile(candidate+suffix,directory,{allowMissing:true,private:true,maxBytes:64*1024*1024});if(sidecar)owned.set(candidate+suffix,sidecar);}
   db?.close();db=undefined;if(input!==undefined){closeSync(input);input=undefined;}if(output!==undefined){closeSync(output);output=undefined;}
   if(created){const current=inspectFile(candidate,directory,{allowMissing:true,private:true,maxBytes:before.size});if(current){if(!sameNode(created,current))throw changed();owned.set(candidate,current);}}
   for(const [name,identity] of owned)if(!removeOwnedFile(name,directory,identity))throw changed();
   removeOwnedDirectory(directory,directory,directoryIdentity);
  }catch(cause){try{db?.close();}catch{}try{if(input!==undefined)closeSync(input);}catch{}try{if(output!==undefined)closeSync(output);}catch{}error??=cause;}
 }
 if(error)throw error;
 return result;
}
