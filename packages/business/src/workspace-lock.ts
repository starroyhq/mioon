// Shared backend/backup exclusion. A lease is the capability, not its PID text.
// Keep the backend's established stale-lock policy; offline backup never takes
// over or removes an existing lock, even if its PID is no longer alive.
import path from 'node:path';
import {validatePrivateDirectory,validateManagedFile,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';

const identityKeys=['dev','ino','size','mtimeMs','ctimeMs'];
export function acquireWorkspaceLock(root,{allowStale=false}={}){
 validatePrivateDirectory(root);
 const lockPath=path.join(root,'server.lock'),token=String(process.pid);
 const previous=readPrivateFile(lockPath,{root,allowMissing:true,private:false,maxBytes:64,encoding:'utf8'});
 if(previous!==null){
  if(!allowStale)throw Object.assign(Error('The workspace has an existing lock. Stop the backend and review the lock before retrying.'),{code:'WORKSPACE_BACKUP_LOCKED'});
  const pid=Number(previous);let active=false;
  if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);active=true;}catch(error){if(error.code!=='ESRCH')active=true;}}
  if(active)throw Error('This data directory already has a running backend');
  removePrivateFile(lockPath,{root,private:false,maxBytes:64});
 }
 writePrivateFileAtomic(lockPath,token,{root,maxBytes:64,replace:false});
 const identity=validateManagedFile(lockPath,{root,private:true,maxBytes:64});
 let active=true,released=false;
 function isOwned(){
  if(!active)return false;
  try{
   const current=validateManagedFile(lockPath,{root,allowMissing:true,private:true,maxBytes:64});
   if(current&&identityKeys.every(key=>current[key]===identity[key])&&readPrivateFile(lockPath,{root,private:true,maxBytes:64,encoding:'utf8'})===token)return true;
  }catch{} // Losing the lease never authorizes replacement or repair.
  active=false;return false;
 }
 function release(){
  if(released)return true;
  // A revoked handle never regains deletion authority. Distinguish verified
  // absence from an unverifiable or replacement path before reporting cleanup.
  if(!isOwned()){
   try{if(validateManagedFile(lockPath,{root,allowMissing:true,private:true,maxBytes:64})===null){released=true;return true;}}catch{}
   return false;
  }
  active=false;
  try{
   removePrivateFile(lockPath,{root,private:true,maxBytes:64});
   released=validateManagedFile(lockPath,{root,allowMissing:true,private:true,maxBytes:64})===null;
  }catch{released=false;}
  return released;
 }
 return Object.freeze({isOwned,release});
}
