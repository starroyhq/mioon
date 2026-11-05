import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,readSync,rmSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {ensurePrivateDirectory,validateManagedFile} from '../../../contracts/src/private-storage.ts';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {AGENT_TASK_STATUSES} from '../../../contracts/src/agent-tasks-v2.ts';
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
export interface ProjectTrashFileGeneration {
 readonly dev:string;
 readonly ino:string;
 readonly size:number;
 readonly mtimeNs:string;
 readonly ctimeNs:string;
 readonly birthtimeNs:string;
}
interface ClosedProjectTrashHistory {
 readonly formatVersion:number;
 readonly seenContentSequence:number;
 readonly seenContentToken:string|null;
 readonly hasBlockingMio:boolean;
}
export interface ClosedProjectTrashInspection {
 readonly projectFile:string;
 readonly identity:ProjectBackupIdentity;
 readonly revision:number;
 readonly generation:ProjectTrashFileGeneration;
 readonly history:ClosedProjectTrashHistory|null;
}
export interface InspectClosedProjectForTrashOptions {
 readonly projectFile:string;
 readonly historyFile:(projectId:string)=>string;
 readonly assertMutationAllowed?:()=>void;
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
function validateHistory(db:DatabaseSync,schema:string,projectId:string):Omit<ClosedProjectTrashHistory,'hasBlockingMio'> {
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
 return {formatVersion:version,seenContentSequence:row.seenContentSequence,seenContentToken:typeof row.seenContentToken==='string'?row.seenContentToken:null};
}

/** Read the actual persisted state, including runs older than journal.list's
 * last-100 window. Callers own the already-validated connection/profile. */
export function hasBlockingMioRun(db:DatabaseSync,projectId:string,schema:'main'|'history'='main'):boolean {
 if(!isProjectId(projectId)||!['main','history'].includes(schema))throw new TypeError('Mio admission requires a project ID and a fixed database schema');
 const tables=db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table' AND name IN ('mio_runs','agent_task_runs_v2')`).all();
 const table=tables.some(row=>row.name==='mio_runs')?'mio_runs':tables.some(row=>row.name==='agent_task_runs_v2')?'agent_task_runs_v2':null;
 if(!table)throw invalid('history','schema');
 // The frozen v2 table had no enum CHECK; an unknown state is not idle.
 if(table==='agent_task_runs_v2'&&db.prepare(`SELECT 1 FROM ${schema}.${table} WHERE projectId=? AND status NOT IN (${AGENT_TASK_STATUSES.map(()=>'?').join(',')}) LIMIT 1`).get(projectId,...AGENT_TASK_STATUSES)!==undefined)throw invalid('history','metadata');
 return db.prepare(`SELECT 1 FROM ${schema}.${table} WHERE projectId=? AND status IN ('accepted','running','paused','awaiting_approval','awaiting_answer','interrupted') LIMIT 1`).get(projectId)!==undefined;
}

const trashGeneration=(info:BigIntStats):ProjectTrashFileGeneration=>{
 const size=Number(info.size);
 if(!Number.isSafeInteger(size)||size<0)throw invalid('project','metadata');
 return {dev:String(info.dev),ino:String(info.ino),size,mtimeNs:String(info.mtimeNs),ctimeNs:String(info.ctimeNs),birthtimeNs:String(info.birthtimeNs)};
};
const trashStamp=(info:BigIntStats):string=>[stamp(info),info.birthtimeNs].join(':');
function checkTrashGeneration(file:string,before:BigIntStats,database:'project'|'history'):void {
 const after=lstatSync(file,{bigint:true});
 if(!after.isFile()||after.isSymbolicLink()||after.nlink!==1n||trashStamp(after)!==trashStamp(before))throw invalid(database,'unusable');
}
function trashSuperJournals(directory:string,database:'project'|'history'):void {
 for(const journal of superJournalsIn(directory)){
  metadata(journal,database);
  // A forged super-journal can list an alias of a live SQLite database.
  // Refuse every such inode before the journal parser opens any of them.
  for(const listed of readFileSync(journal,'utf8').split('\u0000').filter(Boolean)){
   if(!path.isAbsolute(listed))throw invalid(database,'hot-journal');
   if(lstatSync(listed,{throwIfNoEntry:false}))metadata(listed,database);
  }
  if(isSuperJournalInUse(journal))throw invalid(database,'hot-journal');
 }
}

/** Closed-source inspection only: no writable opener, upgrades, snapshots or
 * records creation. Every descriptor is released before the OS trash call. */
export function inspectClosedProjectForTrash(options:InspectClosedProjectForTrashOptions):ClosedProjectTrashInspection {
 if(!path.isAbsolute(options.projectFile))throw new TypeError('Closed project inspection requires an absolute project path');
 const projectFile=path.resolve(options.projectFile),assertAllowed=options.assertMutationAllowed??(()=>{});
 assertAllowed();
 let connection:ReturnType<typeof openClosedProjectSnapshotConnection>|undefined,active:'project'|'history'='project';
 try{
  const before=metadata(projectFile,'project');journals(projectFile,'project');
  trashSuperJournals(path.dirname(projectFile),'project');
  const inspected=inspectProjectFileReadOnly(projectFile),historyFile=options.historyFile(inspected.projectId);
  if(typeof historyFile!=='string'||!path.isAbsolute(historyFile))throw new TypeError('Closed project inspection requires an absolute history path');
  const history=path.resolve(historyFile),historyInfo=lstatSync(history,{bigint:true,throwIfNoEntry:false});
  if(lstatSync(path.join(path.dirname(history),'history-switch-active.json'),{throwIfNoEntry:false}))
   throw new AppError('PROJECT_HISTORY_SWITCH_PENDING','本机记录切换尚未完成，未更改项目。',409,{projectId:inspected.projectId});
  let historyBefore:BigIntStats|undefined;
  if(historyInfo){
   active='history';historyBefore=metadata(history,'history');validateManagedFile(history,{root:path.dirname(history)});journals(history,'history');
   historyHeader(history,historyBefore);
  }else{
   // Orphan sidecars are uncertainty, not evidence of an empty local history.
   for(const suffix of ['-journal','-wal','-shm'])if(lstatSync(history+suffix,{throwIfNoEntry:false}))throw invalid('history','hot-journal');
  }
  trashSuperJournals(path.dirname(history),'history');
  active=historyBefore?'history':'project';
  connection=openClosedProjectSnapshotConnection({projectFile,...(historyBefore?{historyFile:history}:{})});
  const db=connection.db;db.exec('BEGIN');active='project';
  const identity=readCopiedProjectIdentity(db,PROJECT_FILE_APPLICATION_ID,Number(before.size));
  if(identity.projectId!==inspected.projectId||identity.contentSequence!==inspected.contentSequence||identity.contentToken!==inspected.contentToken)throw invalid('project','metadata');
  const row=db.prepare('SELECT data FROM projects WHERE id=?').get(identity.projectId);
  let project:unknown;
  try{if(typeof row?.data!=='string'||Buffer.byteLength(row.data)>4*1024*1024)throw invalid('project','metadata');project=JSON.parse(row.data);}catch{throw invalid('project','metadata');}
  if(project===null||typeof project!=='object'||Array.isArray(project)||!('id' in project)||project.id!==identity.projectId
   ||!('revision' in project)||typeof project.revision!=='number'||!Number.isSafeInteger(project.revision)||project.revision<1)throw invalid('project','metadata');
  let historyResult:ClosedProjectTrashHistory|null=null;
  if(historyBefore){active='history';historyResult={...validateHistory(db,'history',identity.projectId),hasBlockingMio:hasBlockingMioRun(db,identity.projectId,'history')};}
  assertAllowed();
  checkTrashGeneration(projectFile,before,'project');if(historyBefore)checkTrashGeneration(history,historyBefore,'history');
  db.exec('COMMIT');connection.close();connection=undefined;
  // Recheck after releasing our own held identities; no handle escapes.
  checkTrashGeneration(projectFile,before,'project');if(historyBefore)checkTrashGeneration(history,historyBefore,'history');
  assertAllowed();
  return {projectFile,identity,revision:project.revision,generation:trashGeneration(before),history:historyResult};
 }catch(error){
  if(connection?.db.isOpen&&connection.db.isTransaction)connection.db.exec('ROLLBACK');
  if(error instanceof AppError)throw error;
  if(isSqliteBusy(error))throw projectFileError('PROJECT_LOCKED',{database:active,reason:'locked'});
  if(isSqliteCorrupt(error))throw invalid(active);
  if((error as {code?:unknown})?.code==='ENOENT')throw projectFileError(active==='project'?'PROJECT_MISSING':'PROJECT_INVALID',{database:active,reason:active==='project'?'missing':'unusable'});
  throw error;
 }finally{connection?.close();}
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
