import {OPACITY_RIPPLE_CANDIDATE_BACKUP_PROFILE} from './opacity-ripple-candidate-backup-profile.ts';
import path from 'node:path';
import applicationPackage from '../../../package.json' with {type:'json'};
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validatePrivateDirectory,validateManagedDirectory} from '@mioon/contracts/private-storage';
import {WORKSPACE_BACKUP_FORMAT as format,WORKSPACE_BACKUP_FORMAT_VERSION as formatVersion,WORKSPACE_BACKUP_LIMITS as limits,
 workspaceBackupManifestSchema,workspaceBackupCompleteSchema,workspaceBackupResultSchema} from '../../contracts/src/workspace-backup.ts';
import {acquireWorkspaceLock} from './workspace-lock.ts';
import {fail,checkCancelled,safeBackupError,sameNode,sameFile,explicitPath,checkSeparate,createDestination,createNewDirectory,
 checkDirectoryIdentity,inspectFile,syncDirectory,syncDestinationParent,streamFile,readJsonFile,writeBoundedFile,publishMarker,scanDirectory,removeOwnedFile,removeOwnedDirectory} from './workspace-backup-storage.ts';
import {createIssueCollector,buildWorkspaceInventory,inspectDatabase} from './workspace-backup-inventory.ts';
import {detectCurrentWorkspaceRestoreEvidence as detectWorkspaceRestoreEvidence} from './db.ts';
import {hasWorkspaceBackupRestoreEvidence} from './workspace-backup-schema-versions.ts';
import {OPACITY_CANDIDATE_BACKUP_PROFILE} from './opacity-candidate-backup-profile.ts';

import type {Stats} from 'node:fs';

const applicationVersion=applicationPackage.version;

export interface WorkspaceBackupProfile {
 manifestSchema: {safeParse(value: unknown): {success: boolean}};
 resultSchema: {safeParse(value: unknown): {success: boolean}};
 manifestMetadata: Record<string, unknown>;
 resultMetadata: Record<string, unknown>;
 requireSource: (db: DatabaseSync)=>void;
 readSchemaVersion: (db: DatabaseSync)=>number;
}
export interface WorkspaceBackupResult {
 format: string;formatVersion: number;backupId: string;integrity: string;restoration: string;
 databaseSchemaVersion: number;fileCount: number;payloadBytes: number;inventory: unknown;
 warnings?: string[];
}
export interface BackupManifestEntry {path: string;role: string;bytes: number;sha256: string}
export interface VerifiedWorkspaceBackupFile {entry: BackupManifestEntry;identity: Stats}
export interface VerifiedWorkspaceBackupContext {
 directory: string;
 manifest: BackupManifestLike;
 manifestHash: string;
 result: WorkspaceBackupResult;
 files: VerifiedWorkspaceBackupFile[];
 check: ()=>void;
 checkFiles: ()=>void;
 recheck: ()=>Promise<void>;
}
export interface BackupManifestLike {
 backupId: string;databaseSchemaVersion: number;entries: BackupManifestEntry[];inventory: unknown;
}
interface BackupCompleteMarker {format: string;formatVersion: number;backupId: string;manifestSha256: string;fileCount: number;payloadBytes: number}
interface DisposableDatabaseOptions {
 database: string;databaseRoot: string;temporaryParent: string;signal?: AbortSignal;check: ()=>void;databasePrivate?: boolean;
}
interface BackupRestoreCheckOptions {
 database: string;source: string;destination: string;signal?: AbortSignal;check: ()=>void;
}
interface VerifyTreeOptions {signal?: AbortSignal;check: ()=>void}
interface BackupOptions {source?: string;destination?: string;signal?: AbortSignal}
interface VerifyBackupOptions {directory?: string;signal?: AbortSignal;inspectDatabaseCopy?: (db: DatabaseSync)=>Promise<void>|void}
interface VerifiedWorkOptions {signal?: AbortSignal;check: ()=>void}
interface SchemaLike {safeParse(value: unknown): {success: boolean}}

const digest=(bytes: Buffer|Uint8Array|string): string=>createHash('sha256').update(bytes).digest('hex');
const sourceDirectories=['media','image-staging','frame-staging'];
function checkCold(source: string): void{
 for(const name of ['workbench.sqlite-wal','workbench.sqlite-journal','workbench.sqlite-shm']){
  const info=inspectFile(path.join(source,name),source,{allowMissing:true,maxBytes:limits.databaseBytes});
  if(info&&info.size>0&&name!=='workbench.sqlite-shm')fail('NOT_COLD');
 }
}
function sourceDirectorySnapshot(source: string): [string, Stats|null][]{
 return sourceDirectories.map((name): [string, Stats|null]=>[name,validateManagedDirectory(path.join(source,name),{root:source,allowMissing:true,private:name!=='media'})]);
}
function checkSourceDirectories(source: string,snapshots: [string, Stats|null][]): void{
 for(const [name,before] of snapshots){
  const after=validateManagedDirectory(path.join(source,name),{root:source,allowMissing:true,private:name!=='media'});
  if(before?!sameFile(before,after):after!==null)fail('CHANGED');
 }
}
function validated<T>(schema: SchemaLike,value: unknown,reason='CORRUPT'): T{
 if(!schema.safeParse(value).success)fail(reason);return value as T;
}
function checkFixedProfile(fixedProfile: WorkspaceBackupProfile|undefined): void{
 // Only this module-owned fixed candidate is an alternate offline assembly.
 // Public options, copied objects and arbitrary schema-reader callbacks cannot
 // select a new source profile or weaken the historical default reader.
 if(fixedProfile!==undefined&&fixedProfile!==OPACITY_CANDIDATE_BACKUP_PROFILE&&fixedProfile!==OPACITY_RIPPLE_CANDIDATE_BACKUP_PROFILE)fail('DATABASE_INVALID');
}
function resultFor(manifest: BackupManifestLike,fixedProfile: WorkspaceBackupProfile|undefined): WorkspaceBackupResult{
 return validated<WorkspaceBackupResult>(fixedProfile?fixedProfile.resultSchema:workspaceBackupResultSchema,{format,formatVersion,backupId:manifest.backupId,integrity:'verified',restoration:'not_tested',
  databaseSchemaVersion:manifest.databaseSchemaVersion,fileCount:manifest.entries.length,payloadBytes:manifest.entries.reduce((sum,entry)=>sum+entry.bytes,0),inventory:manifest.inventory,
  ...(fixedProfile?fixedProfile.resultMetadata:{})});
}

// SQLite's pathname-only API is restricted to this private disposable copy.
// Even readOnly WAL-mode SQLite may make temporary -wal/-shm files. They never
// appear beside the source database or the published byte-for-byte payload.
export async function withDisposableDatabase<T>({database,databaseRoot,temporaryParent,signal,check,databasePrivate=true}: DisposableDatabaseOptions,fn: (db: DatabaseSync)=>Promise<T>|T): Promise<T>{
 const directory=path.join(temporaryParent,`.inspection-${randomUUID()}`),identity=createNewDirectory(directory,temporaryParent);
 const file=path.join(directory,'workbench.sqlite');let db: DatabaseSync|undefined,copied: Awaited<ReturnType<typeof streamFile>>|undefined;const sidecars=new Map<string, Stats>();let result: T|undefined,error: unknown;
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
   for(const [sidecar,info] of sidecars){
    // SQLite close may change a captured SHM's metadata in place. Reinspect
    // only these already-owned fixed paths; a replacement inode never gains
    // deletion authority, and unknown newly created files are left untouched.
    const current=inspectFile(sidecar,directory,{allowMissing:true,maxBytes:64*1024*1024});
    if(current&&(!sameNode(info,current)||!removeOwnedFile(sidecar,directory,current)))fail('CHANGED');
   }
   removeOwnedDirectory(directory,temporaryParent,identity);
  }catch(cause){try{db?.close();}catch{}error??=cause;}
 }
 if(error)throw error;return result as T;
}

// A restored working branch cannot produce a second-generation backup until
// capture and recursive restore are supported together. Inspect only a private
// disposable copy before creating the user's requested destination. Ordinary
// backup keeps its original permissive byte-preservation/inventory semantics;
// this is not source-schema migration or a general legacy schema validator.
async function refuseRestoredCapture({database,source,destination,signal,check}: BackupRestoreCheckOptions,fixedProfile: WorkspaceBackupProfile|undefined): Promise<void>{
 const temporary=path.join(path.dirname(destination),`.backup-profile-${randomUUID()}`),identity=createDestination(temporary);
 try{
  await withDisposableDatabase({database,databaseRoot:source,temporaryParent:temporary,signal,check,databasePrivate:false},db=>{
   db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
   if(hasWorkspaceBackupRestoreEvidence(db)||(!fixedProfile&&detectWorkspaceRestoreEvidence(db)))throw Object.assign(new Error('Backups of restored working branches are unavailable until recursive restore is supported.'),{code:'RESTORE_BACKUP_UNAVAILABLE'});
   // The candidate proves exact ordinary42 before the requested destination
   // exists; it must not enter the frozen historical dispatcher with source42.
   if(fixedProfile)fixedProfile.requireSource(db);
  });
 }finally{removeOwnedDirectory(temporary,temporary,identity);}
}

/** Cold, local, whole-workspace evidence capture. Never opens/migrates source
 * SQLite, constructs services, repairs sidecars, resumes tasks or restores data.
 * Excluded credential/settings/browser files do not make user-authored DB text
 * secret-free. The private backup needs the same care as the source workspace. */
export async function createWorkspaceBackup({source,destination,signal}: BackupOptions={},fixedProfile?: WorkspaceBackupProfile): Promise<WorkspaceBackupResult>{
 let lease: {isOwned: ()=>boolean;release: ()=>boolean}|undefined,result: WorkspaceBackupResult|undefined,operationError: (Error & {cleanupUnconfirmed?: boolean})|undefined;
 try{
  checkFixedProfile(fixedProfile);
  source=explicitPath(source);destination=explicitPath(destination);checkSeparate(source as string,destination as string);checkCancelled(signal);
  const sourceIdentity=validatePrivateDirectory(source);
  // This shared exclusion is acquired before database/media/staging inspection.
  // It refuses every preexisting lock without deleting even an apparently stale one.
  lease=acquireWorkspaceLock(source);
  const check=()=>{checkCancelled(signal);if(!lease!.isOwned())fail('LOCK_LOST');if(!sameNode(sourceIdentity,validatePrivateDirectory(source as string)))fail('CHANGED');};
  check();checkCold(source);
  const sourceDirs=sourceDirectorySnapshot(source),databasePath=path.join(source,'workbench.sqlite');
  const databaseIdentity=inspectFile(databasePath,source,{maxBytes:limits.databaseBytes})!;if(databaseIdentity.size===0)fail('DATABASE_INVALID');
  await refuseRestoredCapture({database:databasePath,source:source as string,destination:destination as string,signal,check},fixedProfile);
  if(!sameFile(databaseIdentity,inspectFile(databasePath,source,{maxBytes:limits.databaseBytes})))fail('CHANGED');
  const destinationIdentity=createDestination(destination as string);syncDestinationParent(destination as string);check();
  const destinationCheck=(): void=>{check();checkDirectoryIdentity(destination as string,destination as string,destinationIdentity);};
  const payload=path.join(destination as string,'payload');createNewDirectory(payload,destination as string);
  const database=await streamFile({file:databasePath,root:source,destination:path.join(payload,'workbench.sqlite'),destinationRoot:destination,
   signal,check:destinationCheck,maxBytes:limits.databaseBytes,expected:databaseIdentity});
  const databaseEntry: BackupManifestEntry={path:'payload/workbench.sqlite',role:'database',bytes:database.bytes,sha256:database.sha256},issues=createIssueCollector();
  const inventory=await withDisposableDatabase({database:path.join(payload,'workbench.sqlite'),databaseRoot:destination as string,temporaryParent:destination as string,signal,check:destinationCheck},
   db=>buildWorkspaceInventory({db,source:source as string,signal,check:destinationCheck,issues,databaseEntry},fixedProfile));
  const entries: BackupManifestEntry[]=[databaseEntry],directories=new Set([payload]),outputIdentities=new Map<string, Stats|undefined>([[databaseEntry.path,database.savedIdentity]]);let copiedBytes=database.bytes;
  for(const candidate of inventory.plan){
   destinationCheck();
   const output=path.join(payload,candidate.relative),parent=path.dirname(output);
   if(!directories.has(parent)){createNewDirectory(parent,destination as string);directories.add(parent);}
   const value=await streamFile({file:path.join(source as string,candidate.relative),root:source as string,destination:output,destinationRoot:destination as string,
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
  for(const candidate of inventory.plan)if(!sameFile(candidate.identity,inspectFile(path.join(source as string,candidate.relative),source as string,{private:candidate.relative.includes('-staging/')})))fail('CHANGED');
  entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const manifest=validated<BackupManifestLike>(fixedProfile?fixedProfile.manifestSchema:workspaceBackupManifestSchema,{format,formatVersion,backupId:randomUUID(),createdAt:new Date().toISOString(),applicationVersion,
   databaseSchemaVersion:inventory.databaseSchemaVersion,scope:'whole_workspace',entries,inventory:issues.result(),...(fixedProfile?fixedProfile.manifestMetadata:{})},'DATABASE_INVALID');
  const bytes=Buffer.from(JSON.stringify(manifest));
  writeBoundedFile(path.join(destination as string,'manifest.json'),destination as string,bytes,limits.manifestBytes);
  for(const directory of [...directories].sort((a,b)=>b.length-a.length))syncDirectory(directory,destination as string);
  syncDirectory(destination as string,destination as string);syncDestinationParent(destination as string);destinationCheck();
  for(const entry of entries)if(!sameFile(outputIdentities.get(entry.path),inspectFile(path.join(destination as string,entry.path),destination as string,{private:true})))fail('CHANGED');
  const complete=validated<BackupCompleteMarker>(workspaceBackupCompleteSchema,{format,formatVersion,backupId:manifest.backupId,manifestSha256:digest(bytes),fileCount:entries.length,payloadBytes:copiedBytes});
  // COMPLETE is the sole publication point. Every payload, manifest and newly
  // created directory is durable before this no-clobber marker is linked.
  publishMarker(path.join(destination as string,'COMPLETE.json'),destination as string,Buffer.from(JSON.stringify(complete)),destinationCheck);
  result=resultFor(manifest,fixedProfile);return result;
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

async function verifyExactTree(directory: string,manifest: BackupManifestLike,{signal,check}: VerifyTreeOptions): Promise<void>{
 const expected=new Set(['manifest.json','COMPLETE.json','payload',...manifest.entries.map(entry=>entry.path)]),directories=new Set(['','payload']);
 for(const entry of manifest.entries){const parent=path.posix.dirname(entry.path);directories.add(parent);expected.add(parent);}
 const budget={count:0},found=new Set();
 for(const relative of directories){
  await scanDirectory(path.join(directory,relative),directory,{signal,check,budget,private:true,visit:async (name: string)=>{
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
export async function withVerifiedWorkspaceBackup<T=WorkspaceBackupResult>({directory,signal,inspectDatabaseCopy}: VerifyBackupOptions={},use?: (context: VerifiedWorkspaceBackupContext)=>Promise<T>|T,fixedProfile?: WorkspaceBackupProfile): Promise<T|WorkspaceBackupResult>{
  checkFixedProfile(fixedProfile);
  directory=explicitPath(directory);checkCancelled(signal);const rootIdentity=validatePrivateDirectory(directory)!;
  const check=()=>{checkCancelled(signal);checkDirectoryIdentity(directory as string,directory as string,rootIdentity);};
  const marker=readJsonFile(path.join(directory,'COMPLETE.json'),directory,4096,{allowMissing:true});if(!marker)fail('INCOMPLETE');
  const complete=validated<BackupCompleteMarker>(workspaceBackupCompleteSchema,marker.value);
  const input=readJsonFile(path.join(directory as string,'manifest.json'),directory as string,limits.manifestBytes)!;
  if(digest(input.raw)!==complete.manifestSha256)fail('CORRUPT');
  const manifest=validated<BackupManifestLike>(fixedProfile?fixedProfile.manifestSchema:workspaceBackupManifestSchema,input.value),result=resultFor(manifest,fixedProfile);
  if(complete.backupId!==manifest.backupId||complete.fileCount!==result.fileCount||complete.payloadBytes!==result.payloadBytes)fail('CORRUPT');
  const markerIdentity=inspectFile(path.join(directory,'COMPLETE.json'),directory,{private:true,maxBytes:4096});
  const manifestIdentity=inspectFile(path.join(directory,'manifest.json'),directory,{private:true,maxBytes:limits.manifestBytes});
  await verifyExactTree(directory,manifest,{signal,check});
  const verified: [BackupManifestEntry, Stats][]=[];
  for(const entry of manifest.entries){
   const value=await streamFile({file:path.join(directory,entry.path),root:directory,signal,check,maxBytes:entry.role==='database'?limits.databaseBytes:limits.fileBytes,private:true});
   if(value.bytes!==entry.bytes||value.sha256!==entry.sha256)fail('CORRUPT');verified.push([entry,value.identity]);
  }
  // Verification temp files live in a separate private sibling, never inside
  // the backup being verified. No successful verification edits that backup.
  const temporary=path.join(path.dirname(directory),`.backup-verify-${randomUUID()}`),temporaryIdentity=createDestination(temporary);let schemaVersion;
  try{schemaVersion=await withDisposableDatabase({database:path.join(directory,'payload/workbench.sqlite'),databaseRoot:directory,temporaryParent:temporary,signal,check},async db=>{if(inspectDatabaseCopy)await inspectDatabaseCopy(db);return inspectDatabase(db,fixedProfile).version;});}
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
  const freeze=(value: unknown): unknown=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
  const context: VerifiedWorkspaceBackupContext=Object.freeze({directory,manifest:freeze(manifest) as BackupManifestLike,manifestHash:complete.manifestSha256,
   result:freeze(result),files:Object.freeze(verified.map(([entry,identity])=>Object.freeze({entry,identity:Object.freeze(identity)}))),check,checkFiles,recheck}) as unknown as VerifiedWorkspaceBackupContext;
  return use?await use(context):result;
}

export async function verifyWorkspaceBackup({directory,signal}: VerifyBackupOptions={},fixedProfile?: WorkspaceBackupProfile): Promise<unknown>{
 try{return await withVerifiedWorkspaceBackup({directory,signal},undefined,fixedProfile);}
 catch(error){throw safeBackupError(error);}
}
