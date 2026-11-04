import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,rmSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {ensurePrivateDirectory,validateManagedFile} from '../../../contracts/src/private-storage.ts';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {isProjectFileHeld} from './held-files.ts';
import {inspectProjectFileReadOnly,openClosedProjectSnapshotConnection} from './connection.ts';
import {isHotJournal,isSuperJournalInUse,superJournalsIn} from './journals.ts';
import {projectFileError,isSqliteBusy,isSqliteCorrupt} from './errors.ts';
import {HISTORY_APPLICATION_ID,HISTORY_SCHEMA_VERSION,PROJECT_FILE_APPLICATION_ID} from './schema/databases.ts';
import {HISTORY_UPGRADES} from './schema/history-upgrades.ts';
import {compareManifest,readSchemaManifest} from './schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from './schema/manifest.ts';
import {PROJECT_BACKUP_APPLICATION_ID,readCopiedProjectIdentity,syncCopiedFile} from './backup.ts';
import type {ProjectBackupIdentity} from './backup.ts';

export interface CaptureClosedProjectSnapshotOptions {
 readonly projectFile:string;
 readonly historyFile:(projectId:string)=>string;
 /** An application-private, request-owned staging directory, never the source records. */
 readonly directory:string;
 readonly assertMutationAllowed?:()=>void;
 /** Trusted crash/concurrency seam, never taken from an external request. */
 readonly onBoundary?:(boundary:'locked'|'project-copied'|'history-copied')=>void|Promise<void>;
}
export interface ClosedProjectSnapshot {
 readonly identity:ProjectBackupIdentity;
 /** Verified private MioB input for the ordinary owner-change copy builder. */
 readonly projectFile:string;
 readonly historyFile:string|null;
}
const pragma=(db:DatabaseSync,name:string):unknown=>Object.values(db.prepare(`PRAGMA ${name}`).get()??{})[0];
const invalid=(database:'project'|'history',reason:'schema'|'metadata'|'hot-journal'|'not-a-regular-file'|'unusable'|'foreign-key'|'project-mismatch'|'application-id'='schema'):AppError=>
 projectFileError('PROJECT_INVALID',{database,reason});
const stamp=(info:BigIntStats):string=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
function metadata(file:string,database:'project'|'history'):BigIntStats {
 const info=lstatSync(file,{bigint:true});
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)throw invalid(database,'not-a-regular-file');
 if(isProjectFileHeld({dev:String(info.dev),ino:String(info.ino)})||isAppLibraryHeld({dev:String(info.dev),ino:String(info.ino)}))
  throw projectFileError('PROJECT_LOCKED',{database,reason:'locked'});
 return info;
}
function journals(file:string,database:'project'|'history'):void {
 for(const suffix of ['-journal','-wal','-shm']){
  const entry=lstatSync(file+suffix,{bigint:true,throwIfNoEntry:false});
  if(!entry)continue;
  // Journal reads must not close an alias of another held SQLite inode.
  metadata(file+suffix,database);
  if(suffix!=='-journal'||isHotJournal(file+suffix))throw invalid(database,'hot-journal');
 }
}
function historyHeader(file:string,expected:BigIntStats):void {
 const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const actual=fstatSync(fd,{bigint:true}),header=Buffer.alloc(100);
  if(stamp(actual)!==stamp(expected)||readSync(fd,header,0,100,0)!==100||header.toString('latin1',0,16)!=='SQLite format 3\u0000')throw invalid('history');
  if(header.readUInt32BE(68)!==HISTORY_APPLICATION_ID)throw invalid('history','application-id');
  if(header[18]!==1||header[19]!==1)throw invalid('history');
 }finally{closeSync(fd);}
}
function validateHistory(db:DatabaseSync,schema:string,projectId:string):void {
 if(pragma(db,`${schema}.application_id`)!==HISTORY_APPLICATION_ID||pragma(db,`${schema}.journal_mode`)!=='delete'||pragma(db,`${schema}.encoding`)!=='UTF-8')throw invalid('history');
 const versions=db.prepare(`SELECT version FROM ${schema}.schema_version`).all();
 if(versions.length!==1||typeof versions[0].version!=='number')throw invalid('history');
 const version=versions[0].version;
 if(version>HISTORY_SCHEMA_VERSION)throw projectFileError('PROJECT_FORMAT_NEWER',{database:'history',reason:'format-newer',formatVersion:version,supportedFormatVersion:HISTORY_SCHEMA_VERSION});
 const expected=version===HISTORY_SCHEMA_VERSION?SCHEMA_MANIFEST.history:HISTORY_UPGRADES.find(item=>item.from.version===version)?.from;
 if(!expected)throw invalid('history');
 const diff=compareManifest(readSchemaManifest(db,schema),expected.entries);
 if(diff.changed.length||diff.missing.length||diff.unexpected.length)throw invalid('history');
 const states=db.prepare(`SELECT * FROM ${schema}.history_state`).all(),row=states[0];
 if(states.length!==1||row.singleton!==1||row.projectId!==projectId||!isProjectId(row.projectId))throw invalid('history','project-mismatch');
 if(typeof row.seenContentSequence!=='number'||!Number.isSafeInteger(row.seenContentSequence)||row.seenContentSequence<0
  ||Object.hasOwn(row,'seenContentToken')&&row.seenContentToken!==null&&(typeof row.seenContentToken!=='string'||!/^[a-f0-9]{32}$/u.test(row.seenContentToken)))throw invalid('history','metadata');
 if(pragma(db,`${schema}.quick_check`)!=='ok')throw invalid('history');
 if(db.prepare(`PRAGMA ${schema}.foreign_key_check`).get()!==undefined)throw invalid('history','foreign-key');
}

/** No normal opener, migrations, runtime, source writes or source records
 * creation. Both native backups run under one R/O connection/read transaction;
 * acquiring both snapshots first prevents mixing cross-file commits. */
export async function captureClosedProjectSnapshot(options:CaptureClosedProjectSnapshotOptions):Promise<ClosedProjectSnapshot> {
 const project=path.resolve(options.projectFile),directory=path.resolve(options.directory),assertAllowed=options.assertMutationAllowed??(()=>{});
 if(!path.isAbsolute(options.projectFile)||!path.isAbsolute(options.directory))throw new TypeError('Closed project copies require absolute paths');
 assertAllowed();
 let connection:ReturnType<typeof openClosedProjectSnapshotConnection>|undefined,source:DatabaseSync|undefined,active:'project'|'history'='project';
 const created:string[]=[];
 try{
  const before=metadata(project,'project');journals(project,'project');
  const inspected=inspectProjectFileReadOnly(project);
  const history=path.resolve(options.historyFile(inspected.projectId));
  const historyInfo=lstatSync(history,{bigint:true,throwIfNoEntry:false});
  if(lstatSync(path.join(path.dirname(history),'history-switch-active.json'),{throwIfNoEntry:false}))
   throw new AppError('PROJECT_HISTORY_SWITCH_PENDING','本机记录切换尚未完成，未复制项目。',409,{projectId:inspected.projectId});
  let historyBefore:BigIntStats|undefined;
  if(historyInfo){
   active='history';historyBefore=metadata(history,'history');
   // Normal SQLite-created history files can be 0644 inside the private
   // records directory. Preserve that existing kernel contract; never chmod
   // the source merely to copy it.
   validateManagedFile(history,{root:path.dirname(history)});journals(history,'history');
   for(const journal of superJournalsIn(path.dirname(history))){metadata(journal,'history');if(isSuperJournalInUse(journal))throw invalid('history','hot-journal');}
   historyHeader(history,historyBefore);
  }
  active=historyBefore?'history':'project';connection=openClosedProjectSnapshotConnection({projectFile:project,...(historyBefore?{historyFile:history}:{})});source=connection.db;
  active='project';source.exec('BEGIN');
  const identity=readCopiedProjectIdentity(source,PROJECT_FILE_APPLICATION_ID,Number(before.size));
  if(identity.projectId!==inspected.projectId||identity.contentSequence!==inspected.contentSequence||identity.contentToken!==inspected.contentToken)throw invalid('project','metadata');
  if(historyBefore){active='history';validateHistory(source,'history',identity.projectId);}
  if(options.onBoundary)await options.onBoundary('locked');
  assertAllowed();
  ensurePrivateDirectory(directory,{create:true});
  const projectFile=path.join(directory,'project.source.sqlite'),historyFile=historyBefore?path.join(directory,'history.source.sqlite'):null;
  // Native backup overwrites its destination. Reserve every path ourselves.
  for(const file of [projectFile,...(historyFile?[historyFile]:[])]){
   try{closeSync(openSync(file,'wx',0o600));created.push(file);}
   catch(error){if((error as {code?:unknown})?.code==='EEXIST')throw projectFileError('PROJECT_FILE_EXISTS',{database:'project',reason:'exists'});throw error;}
  }
  active='project';await backup(source,projectFile,{source:'main'});assertAllowed();
  if(options.onBoundary)await options.onBoundary('project-copied');
  if(historyFile){active='history';await backup(source,historyFile,{source:'history'});assertAllowed();if(options.onBoundary)await options.onBoundary('history-copied');}
  if(stamp(lstatSync(project,{bigint:true}))!==stamp(before)||historyBefore&&stamp(lstatSync(history,{bigint:true}))!==stamp(historyBefore))throw invalid(active,'unusable');
  source.exec('COMMIT');connection.close();connection=undefined;source=undefined;
  // Only the private, complete snapshot receives the dedicated backup marker.
  const copied=new DatabaseSync(projectFile,{timeout:0,defensive:true});
  let actual:ProjectBackupIdentity;
  try{copied.exec(`PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA application_id=${PROJECT_BACKUP_APPLICATION_ID}`);actual=readCopiedProjectIdentity(copied,PROJECT_BACKUP_APPLICATION_ID,Number(lstatSync(projectFile).size));}
  finally{copied.close();}
  if(historyFile){const copiedHistory=new DatabaseSync(historyFile,{readOnly:true,timeout:0,defensive:true});try{validateHistory(copiedHistory,'main',identity.projectId);}finally{copiedHistory.close();}}
  assertAllowed();for(const file of created)syncCopiedFile(file);
  return {identity:actual,projectFile,historyFile};
 }catch(error){
  if(source?.isOpen){try{if(source.isTransaction)source.exec('ROLLBACK');}finally{connection?.close();connection=undefined;source=undefined;}}
  for(const file of created){rmSync(file,{force:true});rmSync(file+'-journal',{force:true});}
  if(error instanceof AppError)throw error;
  if(isSqliteBusy(error))throw projectFileError('PROJECT_LOCKED',{database:active,reason:'locked'});
  if(isSqliteCorrupt(error))throw invalid(active);
  throw error;
 }finally{connection?.close();}
}
