import {OPACITY_RIPPLE_CANDIDATE_BACKUP_PROFILE} from './opacity-ripple-candidate-backup-profile.ts';
// Local/offline only. Never starts a store, backend, worker or provider; never
// opens the backup's SQLite. The original DB includes private, unredacted text.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {constants,openSync,closeSync,fstatSync,fsyncSync,lstatSync,linkSync,unlinkSync} from 'node:fs';
import {validatePrivateDirectory,validateManagedDirectory} from '@mioon/contracts/private-storage';
import {WORKSPACE_BACKUP_LIMITS as limits} from '../../contracts/src/workspace-backup.ts';
import {workspaceRestoreOfflineResultSchema,workspaceRestorePublicationStatusSchema} from '../../contracts/src/workspace-restore-offline.ts';
import {withVerifiedWorkspaceBackup,withDisposableDatabase} from './workspace-backup.ts';
import {OPACITY_CANDIDATE_BACKUP_PROFILE} from './opacity-candidate-backup-profile.ts';
import {classifyCurrentWorkspaceSchema as classifyWorkspaceSchema,installCurrentWorkspaceRestoreSchema as installWorkspaceRestoreSchema,validateCurrentWorkspaceRestoreSchema as validateWorkspaceRestoreSchema} from './db.ts';
import {acquireWorkspaceLock} from './workspace-lock.ts';
import {checkCancelled,sameNode,sameFile,explicitPath,checkSeparate,createDestination,createNewDirectory,checkDirectoryIdentity,
 inspectFile,streamFile,syncDirectory,syncDestinationParent,scanDirectory,removeOwnedDirectory} from './workspace-backup-storage.ts';
import type {Stats} from 'node:fs';
import type {VerifiedWorkspaceBackupContext,WorkspaceBackupProfile,WorkspaceBackupResult} from './workspace-backup.ts';

interface RestoreProfileData {
 [key: string]: unknown;
 schemaVersion: number;profile: string;sourceSchema: number;heldCounts: unknown;workspaceOrigin: string;
}
export interface WorkspaceRestoreProfile extends WorkspaceBackupProfile {
 sourceVersion: number;
 restoreResultSchema: {safeParse(value: unknown): {success: boolean}};
 restoreStatusSchema: {safeParse(value: unknown): {success: boolean}};
 installRestore: (db: DatabaseSync, info: Record<string, unknown>)=>RestoreProfileData;
 validateRestore: (db: DatabaseSync)=>RestoreProfileData;
}
interface RestoreOptions {directory?: string;destination?: string;signal?: AbortSignal}
interface InspectExpectedOptions {
 destination: string;expected: Record<string, unknown>;signal?: AbortSignal;checkSource?: ()=>void;
}
interface InspectPublicationOptions {
 destination?: string;directory?: string;restorationId?: string;sourceBackupId?: string;
 manifestHash?: string;sourceDbHash?: string;signal?: AbortSignal;
}
interface RestoreOperationError extends Error {cleanupUnconfirmed?: boolean;publication?: Record<string, unknown>}
function isFixedRestoreProfile(fixedProfile: WorkspaceRestoreProfile|undefined): boolean{
 return fixedProfile!==undefined&&(fixedProfile===(OPACITY_CANDIDATE_BACKUP_PROFILE as unknown)||fixedProfile===(OPACITY_RIPPLE_CANDIDATE_BACKUP_PROFILE as unknown));
}

const messages: Readonly<Record<string,string>>=Object.freeze({
 IO:'The offline restore did not complete. Preserve the incomplete destination; use a different new destination after review.',
 INVALID_PATH:'Use explicit canonical absolute backup and new destination directories with no overlap.',
 DESTINATION_WORKSPACE_ANCESTOR:'The destination is inside a directory with an existing workspace database or workspace lock. Choose an independent new destination outside existing workspaces.',
 DESTINATION_EXISTS:'The restore destination already exists. Choose a new destination; existing contents were not changed.',
 LOCKED:'The destination contains a preexisting workspace lock. No lock was removed or repaired.',
 LOCK_LOST:'The destination lock changed. The restore was not activated by this operation.',
 SOURCE_SCHEMA_UNSUPPORTED:'Only fully classified schema24, schema26, schema28, schema30, schema32, schema34, schema36, schema38, schema40 schema44 or schema48 original backups can be restored. Restored or unknown schemas are not supported.',
 CHANGED:'A backup or destination file changed. Preserve the incomplete destination for review.',
 LIMIT:'The backup or restored candidate exceeds a fixed offline restore safety limit.',
 CANCELLED:'Restore was cancelled before activation. The incomplete destination is retained and cannot be reused automatically.',
 DATABASE_INVALID:'The candidate failed fixed schema, captured identity or preservation validation. It was not activated.',
 PUBLICATION_UNCONFIRMED:'The guarded database may have been activated, but publication acknowledgement or durability is unconfirmed. Preserve this destination and check its exact restoration binding; do not rerun restore here.',
 STATUS_UNAVAILABLE:'The destination cannot be safely inspected offline, or does not match the exact expected restoration binding. No repair was attempted.',
});
function error(reason: string): RestoreOperationError{return Object.assign(new Error(messages[reason]||messages.IO),{code:`WORKSPACE_RESTORE_${reason}`});}
const fail: (reason: string)=>never=(reason)=>{throw error(reason);};
function safeError(cause: unknown): Error{
 const failure=cause as {code?: string};
 if(typeof failure?.code==='string'){
  const code=failure.code;
  if(code.startsWith('WORKSPACE_RESTORE_')||['STORAGE_PRIVATE_REQUIRED','STORAGE_PRIVACY_UNAVAILABLE'].includes(code))return cause as Error;
  if(code.startsWith('WORKSPACE_BACKUP_')){
   const reason=code.slice('WORKSPACE_BACKUP_'.length);
   // Preserve verified-backup diagnostics; they are already fixed and sanitized.
   if(['INCOMPLETE','CORRUPT','NOT_COLD'].includes(reason))return cause as Error;
   return error(Object.hasOwn(messages,reason)?reason:'IO');
  }
  if(['RESTORE_SCHEMA_UNSUPPORTED','RESTORE_SOURCE_SCHEMA_UNSUPPORTED'].includes(code))return error('SOURCE_SCHEMA_UNSUPPORTED');
  if(code.startsWith('RESTORE_'))return error(code.includes('LIMIT')?'LIMIT':'DATABASE_INVALID');
  if(code==='EEXIST')return error('DESTINATION_EXISTS');
 }
 return error('IO');
}
function checkDestinationAncestors(destination: string): void{
 // Format1 has no original source-path provenance. Reject the fixed positive
 // workspace/lease markers we can observe, without scanning arbitrary trees.
 // An uninitialized/renamed source lacking both markers cannot be identified.
 for(let ancestor=path.dirname(destination);;ancestor=path.dirname(ancestor)){
  for(const name of ['workbench.sqlite','server.lock']){
   try{lstatSync(path.join(ancestor,name));fail('DESTINATION_WORKSPACE_ANCESTOR');}
   catch(cause){if((cause as {code?: unknown})?.code!=='ENOENT')throw cause;}
  }
  if(path.dirname(ancestor)===ancestor)break;
 }
}
function requireSupportedOriginalSource(db: DatabaseSync): void{
 const profile=classifyWorkspaceSchema(db);
 if(![24,26,28,30,32,34,36,38,40,44,48].includes(profile.schemaVersion)||profile.profile!=='ordinary')fail('SOURCE_SCHEMA_UNSUPPORTED');
}
function sameBinding(info: Record<string,unknown>,expected: Record<string,unknown>): boolean{return ['sourceBackupId','manifestHash','sourceDbHash',...(Object.hasOwn(expected,'restorationId')?['restorationId']:[])].every(key=>info[key]===expected[key]);}
function binding(info: Record<string,unknown>): Record<string,unknown>{return Object.fromEntries(['restorationId','workspaceOrigin','sourceBackupId','manifestHash','sourceDbHash'].map(key=>[key,info[key]]));}
function syncFile(file: string,root: string,expected?: Stats|null): Stats{
 const before=inspectFile(file,root,{private:true,maxBytes:limits.databaseBytes})!;
 if(expected&&!sameFile(before,expected))fail('CHANGED');let fd;
 try{
  fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_NONBLOCK||0));
  if(!sameFile(before,fstatSync(fd)))fail('CHANGED');fsyncSync(fd);
  if(!sameFile(before,fstatSync(fd))||!sameFile(before,inspectFile(file,root,{private:true,maxBytes:limits.databaseBytes})))fail('CHANGED');
 }finally{if(fd!==undefined)closeSync(fd);}
 return before;
}
function noSidecars(file: string,root: string): void{
 for(const suffix of ['-wal','-shm','-journal'])if(inspectFile(file+suffix,root,{allowMissing:true,private:true,maxBytes:limits.databaseBytes}))fail('DATABASE_INVALID');
}
async function exactDestination(root: string,identity: Stats,files: Map<string, Stats|null|undefined>,directories: Map<string, Stats>,check: ()=>void): Promise<void>{
 const budget={count:0},found=new Set();
 for(const directory of directories.keys()){
  await scanDirectory(directory,root,{check,budget,private:true,visit:(name: string)=>{
   const file=path.join(directory,name);if(!files.has(file)&&!directories.has(file))fail('CHANGED');
   if(directories.has(file))checkDirectoryIdentity(file,root,directories.get(file)!);
   else if(file!==path.join(root,'server.lock')&&!sameFile(files.get(file),inspectFile(file,root,{private:true})))fail('CHANGED');
   found.add(file);
  }});
 }
 if(found.size!==files.size+directories.size-1)fail('CHANGED');checkDirectoryIdentity(root,root,identity);check();
}
// Link is atomic and no-clobber. Once it succeeds, errors never roll back or
// delete the launchable pathname. A crash between link/unlink is guarded but
// fails storage's single-link policy. Existing unknown paths are never removed.
function publishCandidate(candidate: string,final: string,root: string,identity: Stats,check: ()=>void,onAttempt: ()=>void,onLinked: ()=>void): Stats{
 check();if(!sameFile(identity,inspectFile(candidate,root,{private:true,maxBytes:limits.databaseBytes})))fail('CHANGED');
 onAttempt();linkSync(candidate,final);onLinked();
 const staged=lstatSync(candidate),published=lstatSync(final);
 if(!sameNode(identity,staged)||!sameNode(identity,published)||staged.nlink!==2||published.nlink!==2||
   staged.size!==identity.size||staged.mtimeMs!==identity.mtimeMs||staged.uid!==identity.uid||staged.mode!==identity.mode)fail('CHANGED');
 unlinkSync(candidate);
 const finalIdentity=inspectFile(final,root,{private:true,maxBytes:limits.databaseBytes})!;
 if(!sameNode(identity,finalIdentity)||finalIdentity.size!==identity.size||finalIdentity.mtimeMs!==identity.mtimeMs)fail('CHANGED');
 syncDirectory(root,root);
 return finalIdentity;
}
// Fixed offline upgrade reuses this exact no-clobber publication boundary.
// This export does not select a source schema or change legacy restore callers.
export {publishCandidate as publishOfflineWorkspaceCandidate, checkDestinationAncestors as checkOfflineWorkspaceDestinationAncestors,
 syncFile as syncOfflineWorkspaceFile, noSidecars as assertOfflineWorkspaceNoSidecars, exactDestination as checkOfflineWorkspaceDestinationTree};

/** Restore format1/schema24 to a new independent private working branch.
 * Backup warnings are preserved, including missing media and incomplete stages.
 * They do not grant execution: every captured identity is independently bounded
 * and validated by the schema constructor. All staged/history bytes are kept.
 * Conservative temporary disk estimate budgets payload + four capped DB-sized
 * copies/journals + 64MiB sidecars; it is not an available-space guarantee. */
export async function restoreWorkspaceBackup({directory,destination,signal}: RestoreOptions={},fixedProfile?: WorkspaceRestoreProfile): Promise<Record<string,unknown>>{
 let lease: {isOwned: ()=>boolean;release: ()=>boolean}|undefined,info: Record<string, unknown>|undefined,linked=false,publicationAttempted=false,result: Record<string,unknown>|undefined,operationError: RestoreOperationError|undefined;
 try{
  // The extra argument is an internal fixed-version seam, not a caller-owned
  // constructor or schema selector. Legacy callers retain the original path.
  if(fixedProfile!==undefined&&!isFixedRestoreProfile(fixedProfile))fail('DATABASE_INVALID');
  const candidateProfile=isFixedRestoreProfile(fixedProfile);
  const requireSource=candidateProfile?fixedProfile!.requireSource:requireSupportedOriginalSource;
  const installRestore=candidateProfile?fixedProfile!.installRestore:installWorkspaceRestoreSchema as unknown as (db: DatabaseSync,info: Record<string,unknown>)=>RestoreProfileData;
  const validateRestore=candidateProfile?fixedProfile!.validateRestore:validateWorkspaceRestoreSchema as unknown as (db: DatabaseSync)=>RestoreProfileData;
  const resultSchema=candidateProfile?fixedProfile!.restoreResultSchema:workspaceRestoreOfflineResultSchema;
  directory=explicitPath(directory);destination=explicitPath(destination);checkSeparate(directory,destination);checkCancelled(signal);
  if(validatePrivateDirectory(destination,{allowMissing:true}))fail('DESTINATION_EXISTS');
  checkDestinationAncestors(destination);
  return (await withVerifiedWorkspaceBackup<Record<string,unknown>>({directory,signal,inspectDatabaseCopy:requireSource},async source=>{
   if(candidateProfile?source.manifest.databaseSchemaVersion!==fixedProfile!.sourceVersion:![24,26,28,30,32,34,36,38,40,44,48].includes(source.manifest.databaseSchemaVersion))fail('SOURCE_SCHEMA_UNSUPPORTED');
   const sourceDatabase=source.files.find(value=>value.entry.role==='database')!;
   info={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:source.manifest.backupId,
    manifestHash:source.manifestHash,sourceDbHash:sourceDatabase.entry.sha256,createdAt:new Date().toISOString()};
   checkDestinationAncestors(destination as string);
   const destinationPath=destination as string;
   const rootIdentity=createDestination(destinationPath);syncDestinationParent(destinationPath);
   lease=acquireWorkspaceLock(destinationPath);
   const check=(): void=>{source.check();checkDirectoryIdentity(destinationPath,destinationPath,rootIdentity);if(!lease!.isOwned())fail('LOCK_LOST');};
   check();syncDirectory(destinationPath,destinationPath);
   const candidate=path.join(destinationPath,`.restore-${info.restorationId as string}.sqlite`),final=path.join(destinationPath,'workbench.sqlite');
   const copied=await streamFile({file:path.join(directory as string,sourceDatabase.entry.path),root:directory as string,destination:candidate,destinationRoot:destinationPath,
    expected:sourceDatabase.identity,private:true,maxBytes:limits.databaseBytes,signal,check});
   if(copied.sha256!==info.sourceDbHash||copied.bytes!==sourceDatabase.entry.bytes)fail('CHANGED');
   check();let db: DatabaseSync|undefined,profile: RestoreProfileData|undefined;
   try{
    db=new DatabaseSync(candidate,{enableForeignKeyConstraints:false,enableDoubleQuotedStringLiterals:false});
    requireSource(db);check();
    // Only fixed source SQL has been classified before any candidate write.
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
    const pageSize=db.prepare('PRAGMA page_size').get()!.page_size as number;
    db.exec(`PRAGMA max_page_count=${Math.floor(limits.databaseBytes/pageSize)}`);
    profile=installRestore(db,info);check();
    const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(checkpoint?.busy)fail('DATABASE_INVALID');
   }finally{db?.close();db=undefined;}
   noSidecars(candidate,destinationPath);check();
   const files=new Map<string, Stats|null|undefined>([[candidate,inspectFile(candidate,destinationPath,{private:true,maxBytes:limits.databaseBytes})],[path.join(destinationPath,'server.lock'),null]]),directories=new Map<string, Stats>([[destinationPath,rootIdentity]]);
   // A ready branch always has its normal empty media directory, even when the
   // source had no payload. Staging directories are created only when captured.
   const media=path.join(destinationPath,'media');directories.set(media,createNewDirectory(media,destinationPath));
   for(const {entry,identity} of source.files){
    if(entry.role==='database')continue;check();
    const target=path.join(destinationPath,entry.path.slice('payload/'.length)),parent=path.dirname(target);
    if(!directories.has(parent)){directories.set(parent,createNewDirectory(parent,destinationPath));}
    const saved=await streamFile({file:path.join(directory as string,entry.path),root:directory as string,destination:target,destinationRoot:destinationPath,expected:identity,private:true,signal,check});
    if(saved.bytes!==entry.bytes||saved.sha256!==entry.sha256)fail('CHANGED');files.set(target,saved.savedIdentity as Stats|null|undefined);
   }
   // Rehash every copied payload, then reopen only the private candidate and
   // validate the guarded main DB independently of the construction handle.
   for(const {entry} of source.files){
    if(entry.role==='database')continue;const target=path.join(destinationPath,entry.path.slice('payload/'.length));
    const stored=await streamFile({file:target,root:destinationPath,expected:files.get(target) as Stats|undefined,private:true,signal,check});
    if(stored.bytes!==entry.bytes||stored.sha256!==entry.sha256)fail('CHANGED');
   }
   try{
    check();db=new DatabaseSync(candidate,{readOnly:true,enableForeignKeyConstraints:false,enableDoubleQuotedStringLiterals:false});
    profile=validateRestore(db);if(!sameBinding(profile,info)||profile.workspaceOrigin!==info.workspaceOrigin)fail('DATABASE_INVALID');
    if(Object.values(db.prepare('PRAGMA quick_check(1)').get()!)[0]!=='ok')fail('DATABASE_INVALID');
   }finally{db?.close();db=undefined;}
   noSidecars(candidate,destinationPath);
   const candidateIdentity=syncFile(candidate,destinationPath,files.get(candidate) as Stats);
   for(const child of [...directories.keys()].sort((a,b)=>b.length-a.length))syncDirectory(child,destinationPath);
   syncDestinationParent(destinationPath);
   await exactDestination(destinationPath,rootIdentity,files,directories,check);
   await source.recheck();check();
   // No awaits after these final inode fences and before activation.
   for(const [file,identity] of files)if(identity&&!sameFile(identity,inspectFile(file,destinationPath,{private:true})))fail('CHANGED');
   for(const [dir,identity] of directories)checkDirectoryIdentity(dir,destinationPath,identity);
   source.checkFiles();check();
   // Prepare/validate the result before activation. There are no cancellation
   // checks after the no-clobber link: a committed branch is never rolled back.
   result={...binding(info),profile:profile!.profile,sourceSchema:profile!.sourceSchema,databaseSchemaVersion:profile!.schemaVersion,publication:'confirmed',createdAt:info.createdAt,
    fileCount:source.result.fileCount,payloadBytes:source.result.payloadBytes,databaseBytes:candidateIdentity.size,
    additionalDiskBytesEstimate:source.result.payloadBytes+4*limits.databaseBytes+64*1024*1024,
    inventory:source.manifest.inventory,heldCounts:profile!.heldCounts,...(candidateProfile?fixedProfile!.resultMetadata:{})};
   if(!resultSchema.safeParse(result).success)fail('DATABASE_INVALID');
   publishCandidate(candidate,final,destinationPath,candidateIdentity,check,()=>{publicationAttempted=true;},()=>{linked=true;});
   return result as Record<string,unknown>;
  },fixedProfile)) as Record<string,unknown>;
 }catch(cause){
  const uncertain=linked||(publicationAttempted&&(cause as {code?: string})?.code!=='EEXIST');
  operationError=uncertain?error('PUBLICATION_UNCONFIRMED'):safeError(cause);
  if(uncertain&&info)operationError.publication={state:'unconfirmed',...binding(info)};
  result=undefined;throw operationError;
 }finally{
  if(lease&&!lease.release()){
   if(result)result.warnings=['DESTINATION_LOCK_RELEASE_UNCONFIRMED'];
   if(operationError)operationError.cleanupUnconfirmed=true;
  }
 }
}

/** Bounded, non-mutating observation for acknowledgement loss. Copies the closed
 * main DB privately and verifies exact supplied provenance. It neither opens a
 * running DB nor repairs a stale lock, two-link publication or SQLite sidecar.
 * Observing guarded bytes now does not prove a previously failed fsync worked. */
async function inspectExpectedPublication({destination,expected,signal,checkSource=()=>{}}: InspectExpectedOptions,fixedProfile?: WorkspaceRestoreProfile): Promise<{result: Record<string,unknown>;recheck: ()=>void}>{
 let temporary: string|undefined,temporaryIdentity: Stats|undefined;
 try{
  if(fixedProfile!==undefined&&!isFixedRestoreProfile(fixedProfile))fail('STATUS_UNAVAILABLE');
  const candidateProfile=isFixedRestoreProfile(fixedProfile);
  const validateRestore=candidateProfile?fixedProfile!.validateRestore:validateWorkspaceRestoreSchema as unknown as (db: DatabaseSync)=>RestoreProfileData;
  const resultSchema=candidateProfile?fixedProfile!.restoreStatusSchema:workspaceRestorePublicationStatusSchema;
  destination=explicitPath(destination);checkCancelled(signal);
  const destinationPath=destination as string;
  const rootIdentity=validatePrivateDirectory(destinationPath)!,database=path.join(destinationPath,'workbench.sqlite');
  const check=(): void=>{
   checkCancelled(signal);checkSource();checkDirectoryIdentity(destinationPath,destinationPath,rootIdentity);
   if(inspectFile(path.join(destinationPath,'server.lock'),destinationPath,{allowMissing:true,maxBytes:64}))fail('STATUS_UNAVAILABLE');
   noSidecars(database,destinationPath);
  };
  check();const before=inspectFile(database,destinationPath,{private:true,maxBytes:limits.databaseBytes});
  temporary=path.join(path.dirname(destinationPath),`.restore-status-${randomUUID()}`);temporaryIdentity=createDestination(temporary);
  const info=await withDisposableDatabase({database,databaseRoot:destinationPath,temporaryParent:temporary,signal,check},db=>validateRestore(db));
  const recheck=(): void=>{check();if(!sameFile(before,inspectFile(database,destinationPath,{private:true,maxBytes:limits.databaseBytes})))fail('STATUS_UNAVAILABLE');};
  recheck();if(!sameBinding(info,expected))fail('STATUS_UNAVAILABLE');
  const result: Record<string,unknown>={...binding(info),profile:info.profile,sourceSchema:info.sourceSchema,databaseSchemaVersion:info.schemaVersion,publication:'observed_guarded',createdAt:info.createdAt,durability:'not_reconfirmed',heldCounts:info.heldCounts,...(candidateProfile?fixedProfile!.resultMetadata:{})};
  if(!resultSchema.safeParse(result).success)fail('STATUS_UNAVAILABLE');return {result,recheck};
 }catch(cause){if((cause as {code?: string})?.code==='WORKSPACE_BACKUP_CANCELLED')throw error('CANCELLED');throw error('STATUS_UNAVAILABLE');}
 finally{if(temporaryIdentity&&temporary)try{removeOwnedDirectory(temporary,temporary,temporaryIdentity);}catch{fail('STATUS_UNAVAILABLE');}}
}

// Exactly one explicit observation mode: known identity, or a fully verified
// original backup. Discovery after total ACK loss does not mint/adopt an origin
// for execution; it discloses the already-guarded target's actual provenance.
export async function inspectWorkspaceRestorePublication({destination,directory,restorationId,sourceBackupId,manifestHash,sourceDbHash,signal}: InspectPublicationOptions={},fixedProfile?: WorkspaceRestoreProfile): Promise<Record<string,unknown>>{
 try{
  if(fixedProfile!==undefined&&!isFixedRestoreProfile(fixedProfile))fail('STATUS_UNAVAILABLE');
  const requireSource=isFixedRestoreProfile(fixedProfile)?fixedProfile!.requireSource:requireSupportedOriginalSource;
  if(directory!==undefined){
   if([restorationId,sourceBackupId,manifestHash,sourceDbHash].some(value=>value!==undefined))fail('STATUS_UNAVAILABLE');
   directory=explicitPath(directory);destination=explicitPath(destination);checkSeparate(directory,destination);
   return (await withVerifiedWorkspaceBackup<Record<string,unknown>>({directory,signal,inspectDatabaseCopy:requireSource},async source=>{
    const expected={sourceBackupId:source.manifest.backupId,manifestHash:source.manifestHash,sourceDbHash:source.files.find(value=>value.entry.role==='database')!.entry.sha256};
    const observation=await inspectExpectedPublication({destination:destination as string,expected,signal,checkSource:source.check},fixedProfile);
    await source.recheck();observation.recheck();return observation.result;
   },fixedProfile)) as Record<string,unknown>;
  }
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,hash=/^[a-f0-9]{64}$/;
  if(![restorationId,sourceBackupId].every(value=>typeof value==='string'&&value.length===36&&uuid.test(value))||![manifestHash,sourceDbHash].every(value=>typeof value==='string'&&value.length===64&&hash.test(value)))fail('STATUS_UNAVAILABLE');
  const observation=await inspectExpectedPublication({destination:destination as string,expected:{restorationId:restorationId as string,sourceBackupId:sourceBackupId as string,manifestHash:manifestHash as string,sourceDbHash:sourceDbHash as string},signal},fixedProfile);
  observation.recheck();return observation.result;
 }catch(cause){if(['WORKSPACE_BACKUP_CANCELLED','WORKSPACE_RESTORE_CANCELLED'].includes((cause as {code?: string})?.code as string))throw error('CANCELLED');throw error('STATUS_UNAVAILABLE');}
}
