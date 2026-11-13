import {closeSync,lstatSync,openSync,renameSync,rmSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {ensurePrivateDirectory} from '../../../contracts/src/private-storage.ts';
import {AppError} from '../../../contracts/src/app-error.ts';
import type {ProjectFileIdentity} from '../../../contracts/src/project-registry.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {inspectProjectFileReadOnly,openProjectCopyReplacementConnections} from './connection.ts';
import type {Format4Options} from './connection.ts';
import {isProjectFileHeld} from './held-files.ts';
import {isSqliteBusy,isSqliteCorrupt,isSqliteReadOnly,projectFileError} from './errors.ts';
import {PROJECT_FILE_APPLICATION_ID} from './schema/databases.ts';
import {inspectCopiedProjectFile,PROJECT_BACKUP_APPLICATION_ID,readCopiedProjectIdentity,syncCopiedDirectory,syncCopiedFile,validateProjectCopyStagingDirectory} from './backup.ts';
import type {ProjectBackupIdentity} from './backup.ts';

type Stamp=Pick<ProjectBackupIdentity,'projectId'|'contentSequence'|'contentToken'>;
export interface LockedProjectCopyReplacement {
 /** Complete verified MioB input, without the old project's local records. */
 readonly projectFile:string;
 readonly identity:ProjectBackupIdentity;
 /** The stage must be in a private child directory beside the selected copy.
  * The caller persists this exact stage identity before requesting replacement. */
 replace(stagedFile:string,expected:Stamp&{readonly fileIdentity:ProjectFileIdentity}):ProjectBackupIdentity;
}
export interface LockedProjectCopyOptions {
 readonly projectFile:string;
 readonly expectedIdentity:ProjectFileIdentity;
 readonly expectedSource:Stamp;
 readonly format4?:Format4Options;
 /** Application-private, request-owned snapshot input; never source records. */
 readonly snapshotDirectory:string;
 readonly assertMutationAllowed?:()=>void;
 /** Trusted crash/concurrency seam; never populated by a public request. */
 readonly onBoundary?:(phase:'locked'|'captured')=>void|Promise<void>;
}
const identity=(info:BigIntStats):ProjectFileIdentity=>({dev:String(info.dev),ino:String(info.ino)});
const sameIdentity=(info:BigIntStats|undefined,expected:ProjectFileIdentity):boolean=>Boolean(info&&String(info.dev)===expected.dev&&String(info.ino)===expected.ino);
const generation=(info:BigIntStats):string=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
const sameStamp=(a:Stamp,b:Stamp):boolean=>a.projectId===b.projectId&&a.contentSequence===b.contentSequence&&a.contentToken===b.contentToken;
const changed=():AppError=>new AppError('PROJECT_COPY_SOURCE_CHANGED','选中的副本已改变，未替换。',409);
const invalid=():AppError=>projectFileError('PROJECT_INVALID',{database:'project',reason:'hot-journal'});

/** Even a cold sidecar belongs to the old physical file. Refuse it rather
 * than deleting it before a possibly failing rename or letting a replacement
 * inherit it. Ordinary closed DELETE-mode project files have no companions. */
function assertNoSidecars(file:string):void {
 for(const suffix of ['-journal','-wal','-shm']){
  const entry=lstatSync(file+suffix,{bigint:true,throwIfNoEntry:false});
  if(!entry)continue;
  if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1n)throw invalid();
  const id=identity(entry);
  if(isProjectFileHeld(id)||isAppLibraryHeld(id))throw projectFileError('PROJECT_LOCKED',{database:'project',reason:'locked'});
  throw invalid();
 }
}

/** Adopt only the selected physical copy. Neither old project identity nor
 * triggers are edited; the ordinary copy builder works on a native backup,
 * then a validated replacement is renamed while the original write lock is
 * still held. Non-SQLite replacement after the final metadata check is the
 * coordinator-approved narrow filesystem race, not an inode-CAS guarantee. */
export async function withLockedProjectCopy<T>(options:LockedProjectCopyOptions,action:(copy:LockedProjectCopyReplacement)=>Promise<T>):Promise<T> {
 const file=path.resolve(options.projectFile),directory=path.resolve(options.snapshotDirectory),assertAllowed=options.assertMutationAllowed??(()=>{});
 if(!path.isAbsolute(options.projectFile)||file!==options.projectFile||!path.isAbsolute(options.snapshotDirectory)||directory!==options.snapshotDirectory)throw new TypeError('Copy adoption requires normalized absolute paths');
 assertAllowed();validateProjectCopyStagingDirectory(path.dirname(file));
 const before=lstatSync(file,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw projectFileError('PROJECT_INVALID',{database:'project',reason:'not-a-regular-file'});
 if(!sameIdentity(before,options.expectedIdentity))throw changed();
 if(isProjectFileHeld(identity(before))||isAppLibraryHeld(identity(before)))throw projectFileError('PROJECT_LOCKED',{database:'project',reason:'locked'});
 assertNoSidecars(file);
 const preflight=inspectProjectFileReadOnly(file,options.format4);
 if(!sameStamp(preflight,options.expectedSource)||generation(lstatSync(file,{bigint:true}))!==generation(before))throw changed();
 let connection:ReturnType<typeof openProjectCopyReplacementConnections>|undefined,created=false,published=false;
 const snapshot=path.join(directory,'project.source.sqlite');
 try{
  connection=openProjectCopyReplacementConnections(file);
  const db=connection.reader,source=readCopiedProjectIdentity(db,PROJECT_FILE_APPLICATION_ID,Number(before.size));
  if(!sameStamp(source,options.expectedSource)||generation(lstatSync(file,{bigint:true}))!==generation(before))throw changed();
  await options.onBoundary?.('locked');assertAllowed();
  ensurePrivateDirectory(directory,{create:true});
  try{closeSync(openSync(snapshot,'wx',0o600));created=true;}
  catch(error){if((error as {code?:unknown})?.code==='EEXIST')throw projectFileError('PROJECT_FILE_EXISTS',{database:'project',reason:'exists'});throw error;}
  await backup(db,snapshot,{source:'main'});assertAllowed();
  const copied=new DatabaseSync(snapshot,{timeout:0,defensive:true});
  let captured:ProjectBackupIdentity;
  try{copied.exec(`PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA application_id=${PROJECT_BACKUP_APPLICATION_ID}`);captured=readCopiedProjectIdentity(copied,PROJECT_BACKUP_APPLICATION_ID,Number(lstatSync(snapshot).size));}
  finally{copied.close();}
  if(!sameStamp(captured,source))throw changed();
  syncCopiedFile(snapshot);await options.onBoundary?.('captured');assertAllowed();
  const capability:LockedProjectCopyReplacement={projectFile:snapshot,identity:captured,replace(stagedFile,expected){
   if(published)throw new TypeError('A selected copy can be replaced only once');
   assertAllowed();
   const stage=path.resolve(stagedFile),stageDirectory=path.dirname(stage);
   if(stage!==stagedFile||path.dirname(stageDirectory)!==path.dirname(file)||!path.basename(stageDirectory).startsWith('.project-copy-'))throw new TypeError('Copy replacement must be staged beside the selected file');
   validateProjectCopyStagingDirectory(stageDirectory);
   const staged=inspectCopiedProjectFile(stage),stageInfo=lstatSync(stage,{bigint:true});
   if(!sameIdentity(stageInfo,expected.fileIdentity)||!sameStamp(staged,expected)||staged.projectId===source.projectId)throw changed();
   if(generation(lstatSync(file,{bigint:true}))!==generation(before)||!sameStamp(readCopiedProjectIdentity(db,PROJECT_FILE_APPLICATION_ID,Number(before.size)),source))throw changed();
   assertNoSidecars(file);
   // A synchronous publication deliberately has no await between admission,
   // exact inode checks and rename. Callers expose async crash seams outside.
   renameSync(stage,file);published=true;syncCopiedDirectory(path.dirname(file));
   for(const suffix of ['-wal','-shm','-journal'])if(lstatSync(file+suffix,{throwIfNoEntry:false}))throw invalid();
   return staged;
  }};
  return await action(capability);
 }catch(error){
  if(error instanceof AppError)throw error;
  if(isSqliteBusy(error))throw projectFileError('PROJECT_LOCKED',{database:'project',reason:'locked'});
  if(isSqliteReadOnly(error))throw projectFileError('PROJECT_INVALID',{database:'project',reason:'read-only'});
  if(isSqliteCorrupt(error))throw projectFileError('PROJECT_INVALID',{database:'project',reason:'schema'});
  throw error;
 }finally{
  connection?.close();
  // Snapshot input is private conversion material, never a diagnostic copy.
  if(created){rmSync(snapshot,{force:true});rmSync(snapshot+'-journal',{force:true});}
 }
}
