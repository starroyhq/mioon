import path from 'node:path';
import applicationPackage from '../../../package.json' with {type:'json'};
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validatePrivateDirectory,validateManagedDirectory} from '@mioon/contracts/private-storage';
import {WORKSPACE_BACKUP_FORMAT as format,WORKSPACE_BACKUP_FORMAT_VERSION as formatVersion,WORKSPACE_BACKUP_LIMITS as limits,
 workspaceBackupManifestSchema,workspaceBackupCompleteSchema,workspaceBackupResultSchema} from '../../contracts/src/workspace-backup.mjs';
import {acquireWorkspaceLock} from './workspace-lock.mjs';
import {fail,checkCancelled,safeBackupError,sameNode,sameFile,explicitPath,checkSeparate,createDestination,createNewDirectory,
 checkDirectoryIdentity,inspectFile,syncDirectory,syncDestinationParent,streamFile,readJsonFile,writeBoundedFile,publishMarker,scanDirectory,removeOwnedFile,removeOwnedDirectory} from './workspace-backup-storage.mjs';
import {createIssueCollector,buildWorkspaceInventory,inspectDatabase} from './workspace-backup-inventory.mjs';
import {detectWorkspaceRestoreEvidence} from './workspace-restore-schema.mjs';

const applicationVersion=applicationPackage.version;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceDirectories=['media','image-staging','frame-staging'];
function checkCold(source){
 for(const name of ['workbench.sqlite-wal','workbench.sqlite-journal','workbench.sqlite-shm']){
  const info=inspectFile(path.join(source,name),source,{allowMissing:true,maxBytes:limits.databaseBytes});
  if(info&&info.size>0&&name!=='workbench.sqlite-shm')fail('NOT_COLD');
 }
}
function sourceDirectorySnapshot(source){
 return sourceDirectories.map(name=>[name,validateManagedDirectory(path.join(source,name),{root:source,allowMissing:true,private:name!=='media'})]);
}
function checkSourceDirectories(source,snapshots){
 for(const [name,before] of snapshots){
  const after=validateManagedDirectory(path.join(source,name),{root:source,allowMissing:true,private:name!=='media'});
  if(before?!sameFile(before,after):after!==null)fail('CHANGED');
 }
}
function validated(schema,value,reason='CORRUPT'){
 if(!schema.safeParse(value).success)fail(reason);return value;
}
function resultFor(manifest){
 return validated(workspaceBackupResultSchema,{format,formatVersion,backupId:manifest.backupId,integrity:'verified',restoration:'not_tested',
  databaseSchemaVersion:manifest.databaseSchemaVersion,fileCount:manifest.entries.length,payloadBytes:manifest.entries.reduce((sum,entry)=>sum+entry.bytes,0),inventory:manifest.inventory});
}

// SQLite's pathname-only API is restricted to this private disposable copy.
// Even readOnly WAL-mode SQLite may make temporary -wal/-shm files. They never
// appear beside the source database or the published byte-for-byte payload.
export async function withDisposableDatabase({database,databaseRoot,temporaryParent,signal,check,databasePrivate=true},fn){
 const directory=path.join(temporaryParent,`.inspection-${randomUUID()}`),identity=createNewDirectory(directory,temporaryParent);
 const file=path.join(directory,'workbench.sqlite');let db,copied;const sidecars=new Map();let result,error;
 const captureSidecars=()=>{
  for(const suffix of ['-wal','-shm','-journal']){
   const name=file+suffix,current=inspectFile(name,directory,{allowMissing:true,maxBytes:64*1024*1024});
   if(!current)continue;
   const first=sidecars.get(name);
   // SQLite may change its own sidecar size/timestamps. A pathname replacement
   // cannot grant deletion authority over a different inode.
   if(first&&!sameNode(first,current))fail('CHANGED');
   sidecars.set(name,current);
  }
 };
 try{
  copied=await streamFile({file:database,root:databaseRoot,destination:file,destinationRoot:directory,signal,check,maxBytes:limits.databaseBytes,private:databasePrivate,cleanupOnFailure:true});
  check();
  db=new DatabaseSync(file,{readOnly:true,enableForeignKeyConstraints:false,enableDoubleQuotedStringLiterals:false});
  captureSidecars();
  result=await fn(db);check();
 }catch(cause){error=cause;}
 finally{
  try{
   // Capture only fixed SQLite sidecars while our connection still owns them;
   // unknown files are never recursively removed.
   if(db)captureSidecars();
   db?.close();db=undefined;
   if(copied&&!removeOwnedFile(file,directory,copied.savedIdentity))fail('CHANGED');
   for(const [sidecar,info] of sidecars){if(!removeOwnedFile(sidecar,directory,info))fail('CHANGED');}
   removeOwnedDirectory(directory,temporaryParent,identity);
  }catch(cause){try{db?.close();}catch{}error??=cause;}
 }
 if(error)throw error;return result;
}

// A restored working branch cannot produce a second-generation backup until
// capture and recursive restore are supported together. Inspect only a private
// disposable copy before creating the user's requested destination. Ordinary
// backup keeps its original permissive byte-preservation/inventory semantics;
// this is not source-schema migration or a general legacy schema validator.
async function refuseRestoredCapture({database,source,destination,signal,check}){
 const temporary=path.join(path.dirname(destination),`.backup-profile-${randomUUID()}`),identity=createDestination(temporary);
 try{
  await withDisposableDatabase({database,databaseRoot:source,temporaryParent:temporary,signal,check,databasePrivate:false},db=>{
   db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
   if(detectWorkspaceRestoreEvidence(db))throw Object.assign(new Error('Backups of restored working branches are unavailable until recursive restore is supported.'),{code:'RESTORE_BACKUP_UNAVAILABLE'});
  });
 }finally{removeOwnedDirectory(temporary,temporary,identity);}
}

/** Cold, local, whole-workspace evidence capture. Never opens/migrates source
 * SQLite, constructs services, repairs sidecars, resumes tasks or restores data.
 * Excluded credential/settings/browser files do not make user-authored DB text
 * secret-free. The private backup needs the same care as the source workspace. */
export async function createWorkspaceBackup({source,destination,signal}={}){
 let lease,result,operationError;
 try{
  source=explicitPath(source);destination=explicitPath(destination);checkSeparate(source,destination);checkCancelled(signal);
  const sourceIdentity=validatePrivateDirectory(source);
  // This shared exclusion is acquired before database/media/staging inspection.
  // It refuses every preexisting lock without deleting even an apparently stale one.
  lease=acquireWorkspaceLock(source);
  const check=()=>{checkCancelled(signal);if(!lease.isOwned())fail('LOCK_LOST');if(!sameNode(sourceIdentity,validatePrivateDirectory(source)))fail('CHANGED');};
  check();checkCold(source);
  const sourceDirs=sourceDirectorySnapshot(source),databasePath=path.join(source,'workbench.sqlite');
  const databaseIdentity=inspectFile(databasePath,source,{maxBytes:limits.databaseBytes});if(databaseIdentity.size===0)fail('DATABASE_INVALID');
  await refuseRestoredCapture({database:databasePath,source,destination,signal,check});
  if(!sameFile(databaseIdentity,inspectFile(databasePath,source,{maxBytes:limits.databaseBytes})))fail('CHANGED');
  const destinationIdentity=createDestination(destination);syncDestinationParent(destination);check();
  const destinationCheck=()=>{check();checkDirectoryIdentity(destination,destination,destinationIdentity);};
  const payload=path.join(destination,'payload');createNewDirectory(payload,destination);
  const database=await streamFile({file:databasePath,root:source,destination:path.join(payload,'workbench.sqlite'),destinationRoot:destination,
   signal,check:destinationCheck,maxBytes:limits.databaseBytes,expected:databaseIdentity});
  const databaseEntry={path:'payload/workbench.sqlite',role:'database',bytes:database.bytes,sha256:database.sha256},issues=createIssueCollector();
  const inventory=await withDisposableDatabase({database:path.join(payload,'workbench.sqlite'),databaseRoot:destination,temporaryParent:destination,signal,check:destinationCheck},
   db=>buildWorkspaceInventory({db,source,signal,check:destinationCheck,issues,databaseEntry}));
  const entries=[databaseEntry],directories=new Set([payload]),outputIdentities=new Map([[databaseEntry.path,database.savedIdentity]]);let copiedBytes=database.bytes;
  for(const candidate of inventory.plan){
   destinationCheck();
   const output=path.join(payload,candidate.relative),parent=path.dirname(output);
   if(!directories.has(parent)){createNewDirectory(parent,destination);directories.add(parent);}
   const value=await streamFile({file:path.join(source,candidate.relative),root:source,destination:output,destinationRoot:destination,
    signal,check:destinationCheck,expected:candidate.identity,private:candidate.relative.includes('-staging/')});
   copiedBytes+=value.bytes;if(copiedBytes>limits.totalBytes||entries.length>=limits.fileCount)fail('LIMIT');
   if((candidate.sha256&&candidate.sha256!==value.sha256)||(candidate.bytes!==undefined&&candidate.bytes!==value.bytes))issues.add(candidate.role==='asset'?'REGISTERED_MEDIA_MISMATCH':'INCONSISTENT_STAGE_RECEIPT',candidate.relative);
   entries.push({path:`payload/${candidate.relative}`,role:candidate.role,bytes:value.bytes,sha256:value.sha256});
   outputIdentities.set(`payload/${candidate.relative}`,value.savedIdentity);
  }
  // Verify the stored destination bytes independently of the source stream.
  // A successful write/fsync alone is not evidence for integrity:'verified'.
  for(const entry of entries){
   const stored=await streamFile({file:path.join(destination,entry.path),root:destination,signal,check:destinationCheck,
    expected:outputIdentities.get(entry.path),maxBytes:entry.role==='database'?limits.databaseBytes:limits.fileBytes,private:true});
   if(stored.bytes!==entry.bytes||stored.sha256!==entry.sha256)fail('CORRUPT');
  }
  // Recheck every admitted source inode and cold boundary after all asynchronous
  // copying, so a changed earlier file cannot silently become a mixed capture.
  destinationCheck();checkCold(source);checkSourceDirectories(source,sourceDirs);
  if(!sameFile(databaseIdentity,inspectFile(databasePath,source,{maxBytes:limits.databaseBytes})))fail('CHANGED');
  for(const candidate of inventory.plan)if(!sameFile(candidate.identity,inspectFile(path.join(source,candidate.relative),source,{private:candidate.relative.includes('-staging/')})))fail('CHANGED');
  entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const manifest=validated(workspaceBackupManifestSchema,{format,formatVersion,backupId:randomUUID(),createdAt:new Date().toISOString(),applicationVersion,
   databaseSchemaVersion:inventory.databaseSchemaVersion,scope:'whole_workspace',entries,inventory:issues.result()},'DATABASE_INVALID');
  const bytes=Buffer.from(JSON.stringify(manifest));
  writeBoundedFile(path.join(destination,'manifest.json'),destination,bytes,limits.manifestBytes);
  for(const directory of [...directories].sort((a,b)=>b.length-a.length))syncDirectory(directory,destination);
  syncDirectory(destination,destination);syncDestinationParent(destination);destinationCheck();
  for(const entry of entries)if(!sameFile(outputIdentities.get(entry.path),inspectFile(path.join(destination,entry.path),destination,{private:true})))fail('CHANGED');
  const complete=validated(workspaceBackupCompleteSchema,{format,formatVersion,backupId:manifest.backupId,manifestSha256:digest(bytes),fileCount:entries.length,payloadBytes:copiedBytes});
  // COMPLETE is the sole publication point. Every payload, manifest and newly
  // created directory is durable before this no-clobber marker is linked.
  publishMarker(path.join(destination,'COMPLETE.json'),destination,Buffer.from(JSON.stringify(complete)),destinationCheck);
  result=resultFor(manifest);return result;
 }catch(error){operationError=safeBackupError(error);throw operationError;}
 finally{
  // Publication and source-lock cleanup are separate outcomes. Never revoke a
  // durable COMPLETE or replace the original cancellation/failure diagnosis.
  // This is point-in-time confirmation, not crash-durable release of the lock.
  if(lease&&!lease.release()){
   if(result)result.warnings=['SOURCE_LOCK_RELEASE_UNCONFIRMED'];
   if(operationError)operationError.cleanupUnconfirmed=true;
  }
 }
}

async function verifyExactTree(directory,manifest,{signal,check}){
 const expected=new Set(['manifest.json','COMPLETE.json','payload',...manifest.entries.map(entry=>entry.path)]),directories=new Set(['','payload']);
 for(const entry of manifest.entries){const parent=path.posix.dirname(entry.path);directories.add(parent);expected.add(parent);}
 const budget={count:0},found=new Set();
 for(const relative of directories){
  await scanDirectory(path.join(directory,relative),directory,{signal,check,budget,private:true,visit:async name=>{
   const target=relative?`${relative}/${name}`:name;
   if(!expected.has(target))fail('CORRUPT');
   const full=path.join(directory,target);
   if(directories.has(target))validateManagedDirectory(full,{root:directory,private:true});
   else inspectFile(full,directory,{private:true,maxBytes:target==='manifest.json'?limits.manifestBytes:target==='COMPLETE.json'?4096:target==='payload/workbench.sqlite'?limits.databaseBytes:limits.fileBytes});
   found.add(target);
  }});
 }
 if(expected.size!==found.size||[...expected].some(value=>!found.has(value)))fail('CORRUPT');
}

/** Rehash exact captured bytes and inspect only a disposable database copy.
 * Integrity is not authenticity, inventory completeness or restoration proof. */
export async function withVerifiedWorkspaceBackup({directory,signal,inspectDatabaseCopy}={},use){
  directory=explicitPath(directory);checkCancelled(signal);const rootIdentity=validatePrivateDirectory(directory);
  const check=()=>{checkCancelled(signal);checkDirectoryIdentity(directory,directory,rootIdentity);};
  const marker=readJsonFile(path.join(directory,'COMPLETE.json'),directory,4096,{allowMissing:true});if(!marker)fail('INCOMPLETE');
  const complete=validated(workspaceBackupCompleteSchema,marker.value);
  const input=readJsonFile(path.join(directory,'manifest.json'),directory,limits.manifestBytes);
  if(digest(input.raw)!==complete.manifestSha256)fail('CORRUPT');
  const manifest=validated(workspaceBackupManifestSchema,input.value),result=resultFor(manifest);
  if(complete.backupId!==manifest.backupId||complete.fileCount!==result.fileCount||complete.payloadBytes!==result.payloadBytes)fail('CORRUPT');
  const markerIdentity=inspectFile(path.join(directory,'COMPLETE.json'),directory,{private:true,maxBytes:4096});
  const manifestIdentity=inspectFile(path.join(directory,'manifest.json'),directory,{private:true,maxBytes:limits.manifestBytes});
  await verifyExactTree(directory,manifest,{signal,check});
  const verified=[];
  for(const entry of manifest.entries){
   const value=await streamFile({file:path.join(directory,entry.path),root:directory,signal,check,maxBytes:entry.role==='database'?limits.databaseBytes:limits.fileBytes,private:true});
   if(value.bytes!==entry.bytes||value.sha256!==entry.sha256)fail('CORRUPT');verified.push([entry,value.identity]);
  }
  // Verification temp files live in a separate private sibling, never inside
  // the backup being verified. No successful verification edits that backup.
  const temporary=path.join(path.dirname(directory),`.backup-verify-${randomUUID()}`),temporaryIdentity=createDestination(temporary);let schemaVersion;
  try{schemaVersion=await withDisposableDatabase({database:path.join(directory,'payload/workbench.sqlite'),databaseRoot:directory,temporaryParent:temporary,signal,check},async db=>{if(inspectDatabaseCopy)await inspectDatabaseCopy(db);return inspectDatabase(db).version;});}
  finally{removeOwnedDirectory(temporary,temporary,temporaryIdentity);}
  if(schemaVersion!==manifest.databaseSchemaVersion)fail('CORRUPT');
  const checkFiles=()=>{
   check();
   for(const [entry,identity] of verified)if(!sameFile(identity,inspectFile(path.join(directory,entry.path),directory,{private:true})))fail('CHANGED');
   if(!sameFile(markerIdentity,inspectFile(path.join(directory,'COMPLETE.json'),directory,{private:true,maxBytes:4096}))||!sameFile(manifestIdentity,inspectFile(path.join(directory,'manifest.json'),directory,{private:true,maxBytes:limits.manifestBytes})))fail('CHANGED');
  };
  const recheck=async()=>{checkFiles();await verifyExactTree(directory,manifest,{signal,check});checkFiles();};
  await recheck();
  if(!use)return result;
  // Trusted offline embedding only. This is not registered in the RPC catalog.
  // Freeze all supplied evidence; callers cannot mutate our later rechecks.
  const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
  const context=Object.freeze({directory,manifest:freeze(manifest),manifestHash:complete.manifestSha256,
   result:freeze(result),files:Object.freeze(verified.map(([entry,identity])=>Object.freeze({entry,identity:Object.freeze(identity)}))),check,checkFiles,recheck});
  return use?await use(context):result;
}

export async function verifyWorkspaceBackup({directory,signal}={}){
 try{return await withVerifiedWorkspaceBackup({directory,signal});}
 catch(error){throw safeBackupError(error);}
}
