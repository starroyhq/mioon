/** Explicit offline ordinary40 -> ordinary42 copy. Neither source nor backup
 * SQLite is opened. Historical constructors and default startup stay fixed. */
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isPromise} from 'node:util/types';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {OPACITY_UPGRADE_ERROR_CODES, opacityWorkspaceUpgradeResultSchema} from '../../contracts/src/opacity-upgrade.ts';
import type {OpacityUpgradeErrorCode, OpacityWorkspaceUpgradeResult} from '../../contracts/src/opacity-upgrade.ts';
import {requireEligibleOrdinary40, upgradeCopiedDatabase40To42} from './opacity-upgrade-database.ts';
import {classifyWorkspaceSchema42} from './workspace-schema-v42.ts';
import {captureOpacityUpgradeCompanions, rebindOpacityUpgradeLastProject, verifyOpacityUpgradeCompanionCapture} from './opacity-upgrade-companions.ts';
import type {OpacityUpgradeCompanionCapture, OpacityUpgradeCompanionChannel, OpacityUpgradeFileIdentity} from './opacity-upgrade-companions.ts';

const require = createRequire(import.meta.url);
// Checked, concrete legacy boundaries only. No caller-supplied profile, reader,
// path resolver, constructor or plugin chooses these internal modules.
const legacy: Readonly<Record<'storage'|'backup'|'inventory'|'restore'|'locks'|'private'|'contract', unknown>> = Object.freeze({
  storage: require('./workspace-backup-storage.ts'), backup: require('./workspace-backup.ts'),
  inventory: require('./workspace-backup-inventory.ts'), restore: require('./workspace-restore.ts'),
  locks: require('./workspace-lock.ts'), private: require('../../contracts/src/private-storage.ts'),
  contract: require('../../contracts/src/workspace-backup.ts'),
});
type Value = Record<string, unknown>;
type Method = (...args: unknown[]) => unknown;
type Identity = OpacityUpgradeFileIdentity;
type FaultPoint = 'afterValidation'|'afterDatabase'|'afterMedia'|'beforePublish'|'afterPublish';
export interface OpacityWorkspaceUpgradeOptions {
  readonly source: string; readonly backup: string; readonly destination: string;
  readonly channel: OpacityUpgradeCompanionChannel; readonly signal?: AbortSignal;
  /** Synchronous test-only failure injection; never exposed through CLI/RPC. */
  readonly fault?: (point: FaultPoint) => void;
}
interface Publication {state:'unconfirmed';sourceBackupId:string;manifestHash:string;sourceDbHash:string;targetDbHash?:string}
export class OpacityWorkspaceUpgradeError extends Error {
  readonly code: OpacityUpgradeErrorCode;
  cleanupUnconfirmed?: true;
  publication?: Publication;
  constructor(code: OpacityUpgradeErrorCode) {super(`Offline workspace upgrade stopped (${code}). Source data was not changed.`); this.code=code;}
}
const object = (value: unknown): value is Value => value!==null && typeof value==='object' && !Array.isArray(value);
const fail = (suffix: string): never => {throw new OpacityWorkspaceUpgradeError(OPACITY_UPGRADE_ERROR_CODES.find(code=>code===`WORKSPACE_UPGRADE_${suffix}`)??'WORKSPACE_UPGRADE_IO');};
function invoke(module: keyof typeof legacy, name: string, args: readonly unknown[]): unknown {
  const runtime=legacy[module];
  if(!object(runtime) || typeof runtime[name]!=='function') return fail('IO');
  return Reflect.apply(runtime[name], runtime, args);
}
function identity(value: unknown): Identity {
  if(!object(value) || !['dev','ino'].every(key=>typeof value[key]==='number'||typeof value[key]==='bigint') ||
    !['size','mtimeMs','ctimeMs','birthtimeMs','uid','mode','nlink'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key]))) return fail('CHANGED');
  return value as unknown as Identity;
}
const sameNode = (left:Identity,right:Identity):boolean => left.dev===right.dev && left.ino===right.ino;
const sameFile = (left:Identity,right:Identity):boolean => sameNode(left,right) &&
  (['size','mtimeMs','ctimeMs','uid','mode','nlink'] as const).every(key=>left[key]===right[key]);
function directory(root:string, allowMissing=false):Identity|null {
  const value=invoke('private','validatePrivateDirectory',[root,{allowMissing}]);return value===null?null:identity(value);
}
function inspect(file:string, root:string, {allowMissing=false,private:privateMode=false,maxBytes=8*1024**3}={}):Identity|null {
  const value=invoke('storage','inspectFile',[file,root,{allowMissing,private:privateMode,maxBytes}]);return value===null?null:identity(value);
}
function requiredFile(file:string,root:string,privateMode=false,maxBytes=8*1024**3):Identity {
  const found=inspect(file,root,{private:privateMode,maxBytes});if(!found)return fail('SOURCE_INVALID');return found;
}
function managedDirectory(file:string,root:string,privateMode:boolean):Identity|null {
  const value=invoke('private','validateManagedDirectory',[file,{root,allowMissing:true,private:privateMode}]);return value===null?null:identity(value);
}
interface Lease {isOwned():boolean;release():boolean}
function acquire(root:string):Lease {
  const lease=invoke('locks','acquireWorkspaceLock',[root]);
  if(!object(lease)||typeof lease.isOwned!=='function'||typeof lease.release!=='function')return fail('LOCKED');
  return {isOwned:()=>Reflect.apply(lease.isOwned as Method,lease,[])===true,release:()=>Reflect.apply(lease.release as Method,lease,[])===true};
}
function absent(destination:string):void {
  try{const info=lstatSync(destination);if(info.isSymbolicLink())return fail('INVALID_PATH');return fail('DESTINATION_EXISTS');}
  catch(error){if(object(error)&&error.code==='ENOENT')return;throw error;}
}
function explicit(value:string):string {const found=invoke('storage','explicitPath',[value]);if(typeof found!=='string')return fail('INVALID_PATH');return found;}
function cold(root:string):void {
  for(const suffix of ['-wal','-journal','-shm']) {
    const found=inspect(path.join(root,'workbench.sqlite'+suffix),root,{allowMissing:true,maxBytes:512*1024**2});
    if(found&&found.size>0&&suffix!=='-shm')fail('NOT_COLD');
  }
}
interface StreamResult {bytes:number;sha256:string;identity:Identity;savedIdentity?:Identity}
async function stream(options:Value):Promise<StreamResult> {
  const value=await invoke('storage','streamFile',[{...options,...(typeof options.destination==='string'?{cleanupOnFailure:true}:{})}]);
  if(!object(value)||!Number.isSafeInteger(value.bytes)||typeof value.bytes!=='number'||value.bytes<0||
    typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(value.sha256))return fail('IO');
  return {bytes:value.bytes,sha256:value.sha256,identity:identity(value.identity),...(value.savedIdentity?{savedIdentity:identity(value.savedIdentity)}:{})};
}
interface Entry {path:string;role:string;bytes:number;sha256:string}
interface Verified {directory:string;manifestHash:string;backupId:string;files:ReadonlyArray<{entry:Entry;identity:Identity}>;
  check():void;recheck():Promise<void>}
function verified(value:unknown):Verified {
  if(!object(value)||typeof value.directory!=='string'||typeof value.manifestHash!=='string'||!/^[a-f0-9]{64}$/u.test(value.manifestHash)||
    !object(value.manifest)||value.manifest.databaseSchemaVersion!==40||typeof value.manifest.backupId!=='string'||
    !object(value.manifest.inventory)||value.manifest.inventory.complete!==true||value.manifest.inventory.totalIssues!==0||
    !Array.isArray(value.files)||value.files.length<1||value.files.length>20000||typeof value.check!=='function'||typeof value.recheck!=='function') return fail('INVENTORY_INCOMPLETE');
  const files=value.files.map(item=>{
    if(!object(item)||!object(item.entry))return fail('SOURCE_INVALID');
    const entry=item.entry;
    if(typeof entry.path!=='string'||invoke('contract','isWorkspaceBackupPayloadPath',[entry.path])!==true)return fail('SOURCE_INVALID');
    if(typeof entry.role!=='string'||typeof entry.bytes!=='number'||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||
      typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(entry.sha256))return fail('SOURCE_INVALID');
    return {entry:{path:entry.path,role:entry.role,bytes:entry.bytes,sha256:entry.sha256},identity:identity(item.identity)};
  });
  // The shared format1 verifier already checked the complete strict manifest,
  // exact canonical payload grammar and all inode/hash evidence before this.
  return {directory:value.directory,manifestHash:value.manifestHash,backupId:value.manifest.backupId,files,
    check:()=>{Reflect.apply(value.check as Method,value,[]);},recheck:async()=>{await Reflect.apply(value.recheck as Method,value,[]);}};
}
function mapped(error:unknown):OpacityWorkspaceUpgradeError {
  if(error instanceof OpacityWorkspaceUpgradeError)return error;
  const code=object(error)&&typeof error.code==='string'?error.code:'';
  const known=OPACITY_UPGRADE_ERROR_CODES.find(value=>value===code);if(known)return new OpacityWorkspaceUpgradeError(known);
  const direct=['SOURCE_INVALID','SOURCE_UNSUPPORTED','UNRESOLVED_TASKS','UNSUPPORTED_ASSET','UNSUPPORTED_EXPORT','PRESERVATION_FAILED'];
  if(direct.includes(code))return new OpacityWorkspaceUpgradeError(`WORKSPACE_UPGRADE_${code}` as OpacityUpgradeErrorCode);
  if(code.startsWith('OPACITY_UPGRADE_COMPANION_')){
    const suffix=code.slice('OPACITY_UPGRADE_COMPANION_'.length);
    return new OpacityWorkspaceUpgradeError(`WORKSPACE_UPGRADE_${suffix==='SCOPE_MISMATCH'?'SCOPE_MISMATCH':suffix==='CHANGED'?'CHANGED':['ACTIVE','UNSUPPORTED'].includes(suffix)?'DRAFTS_UNSUPPORTED':'COMPANION_INVALID'}` as OpacityUpgradeErrorCode);
  }
  if(code==='RESTORE_BACKUP_UNAVAILABLE'||code.startsWith('RESTORE_'))return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_SOURCE_UNSUPPORTED');
  if(code.startsWith('WORKSPACE_BACKUP_')||code.startsWith('WORKSPACE_RESTORE_')){
    const suffix=code.replace(/^WORKSPACE_(?:BACKUP|RESTORE)_/u,'');
    if(['LOCKED','LOCK_LOST','NOT_COLD','LIMIT','CANCELLED','CHANGED','INVALID_PATH','DESTINATION_EXISTS','DESTINATION_WORKSPACE_ANCESTOR'].includes(suffix))return new OpacityWorkspaceUpgradeError(`WORKSPACE_UPGRADE_${suffix}` as OpacityUpgradeErrorCode);
    if(['CORRUPT','INCOMPLETE','DATABASE_INVALID'].includes(suffix))return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_SOURCE_INVALID');
  }
  if(code==='EEXIST')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_DESTINATION_EXISTS');
  if(code==='STORAGE_IO_ERROR')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_IO');
  if(code==='STORAGE_SIZE_LIMIT')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_LIMIT');
  if(code==='STORAGE_FILE_CHANGED')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_CHANGED');
  if(code==='STORAGE_ALREADY_EXISTS')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_DESTINATION_EXISTS');
  if(code.startsWith('STORAGE_')){
    const reason=object(error)&&typeof error.reason==='string'?error.reason:'';
    if(reason==='IO_ERROR')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_IO');
    if(reason==='SIZE_LIMIT')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_LIMIT');
    if(reason==='FILE_CHANGED')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_CHANGED');
    if(reason==='ALREADY_EXISTS')return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_DESTINATION_EXISTS');
    return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_INVALID_PATH');
  }
  return new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_IO');
}

export async function upgradeOpacityWorkspace40To42(options:OpacityWorkspaceUpgradeOptions):Promise<OpacityWorkspaceUpgradeResult> {
  let sourceLease:Lease|undefined,destinationLease:Lease|undefined,result:OpacityWorkspaceUpgradeResult|undefined;
  let operationError:OpacityWorkspaceUpgradeError|undefined,attempted=false,linked=false,publication:Publication|undefined;
  let target:string|undefined,targetIdentity:Identity|undefined;
  const files=new Map<string,Identity|null>(),directories=new Map<string,Identity>();
  const ownedCandidate=new Map<string,Identity>();
  const inject=(point:FaultPoint):void=>{const returned:unknown=options.fault?.(point);if(returned&&(typeof returned==='object'||typeof returned==='function')&&'then' in returned){if(isPromise(returned))void returned.catch(()=>{});return fail('IO');}};
  try {
    if(!['web','production','development'].includes(options.channel))return fail('INVALID_PATH');
    const source=explicit(options.source),backup=explicit(options.backup),destination=explicit(options.destination);target=destination;
    for(const [left,right] of [[source,backup],[source,destination],[backup,destination]])invoke('storage','checkSeparate',[left,right]);
    invoke('storage','checkCancelled',[options.signal]);absent(destination);
    invoke('restore','checkOfflineWorkspaceDestinationAncestors',[destination]);
    const sourceIdentity=directory(source);if(!sourceIdentity)return fail('SOURCE_INVALID');
    directory(backup); // Existing verified archive only; never captured here.
    sourceLease=acquire(source);const lease=sourceLease;
    const database=path.join(source,'workbench.sqlite'),sourceDatabase=requiredFile(database,source,false,512*1024**2);
    const sourceDirectories=new Map(['media','image-staging','frame-staging'].map(name=>[name,managedDirectory(path.join(source,name),source,name!=='media')]));
    const checkSource=():void=>{
      invoke('storage','checkCancelled',[options.signal]);
      if(!lease.isOwned())return fail('LOCK_LOST');
      const current=directory(source);if(!current||!sameNode(current,sourceIdentity)||!sameFile(sourceDatabase,requiredFile(database,source,false,512*1024**2)))return fail('CHANGED');
      cold(source);
      for(const [name,before] of sourceDirectories){const after=managedDirectory(path.join(source,name),source,name!=='media');if(before?!after||!sameFile(before,after):after!==null)return fail('CHANGED');}
    };
    checkSource();
    const original=await stream({file:database,root:source,expected:sourceDatabase,maxBytes:512*1024**2,signal:options.signal,check:checkSource});
    let companions:OpacityUpgradeCompanionCapture|undefined;
    let plan:ReadonlyArray<{relative:string;role:string;identity:Identity}>|undefined;
    const inspectDatabaseCopy=async(value:unknown):Promise<void>=>{
      if(!(value instanceof DatabaseSync))return fail('SOURCE_INVALID');
      value.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
      requireEligibleOrdinary40(value);checkSource();
      companions=captureOpacityUpgradeCompanions({root:source,channel:options.channel,db:value,directoryIdentity:sourceIdentity,databaseIdentity:sourceDatabase});
      const issues=invoke('inventory','createIssueCollector',[]);
      if(!object(issues)||typeof issues.result!=='function')return fail('IO');
      const inventory=await invoke('inventory','buildWorkspaceInventory',[{db:value,source,signal:options.signal,check:checkSource,issues,
        databaseEntry:{path:'payload/workbench.sqlite',role:'database',bytes:original.bytes,sha256:original.sha256}}]);
      const outcome:unknown=Reflect.apply(issues.result,issues,[]);
      if(!object(outcome)||outcome.complete!==true||outcome.totalIssues!==0||!object(inventory)||inventory.databaseSchemaVersion!==40||!Array.isArray(inventory.plan))return fail('INVENTORY_INCOMPLETE');
      plan=inventory.plan.map(item=>{if(!object(item)||typeof item.relative!=='string'||typeof item.role!=='string')return fail('SOURCE_INVALID');return {relative:item.relative,role:item.role,identity:identity(item.identity)};});
    };
    const upgraded=await invoke('backup','withVerifiedWorkspaceBackup',[{directory:backup,signal:options.signal,inspectDatabaseCopy},async(raw:unknown)=>{
      const archive=verified(raw),captured=companions,inventory=plan;
      if(!captured||!inventory)return fail('SOURCE_INVALID');
      const sourceDb=archive.files.find(item=>item.entry.role==='database');
      if(!sourceDb||sourceDb.entry.path!=='payload/workbench.sqlite'||sourceDb.entry.sha256!==original.sha256||sourceDb.entry.bytes!==original.bytes)return fail('CHANGED');
      if(archive.files.length!==inventory.length+1)return fail('CHANGED');
      const sourceFiles=new Map<string,Identity>([[database,sourceDatabase]]);
      for(const candidate of inventory){
        const entry=archive.files.find(item=>item.entry.path===`payload/${candidate.relative}`)?.entry;
        if(!entry||entry.role!==candidate.role)return fail('CHANGED');
        const sourceFile=path.join(source,candidate.relative),value=await stream({file:sourceFile,root:source,expected:candidate.identity,
          private:candidate.relative.includes('-staging/'),signal:options.signal,check:checkSource});
        if(value.bytes!==entry.bytes||value.sha256!==entry.sha256)return fail('CHANGED');sourceFiles.set(sourceFile,value.identity);
      }
      const check=():void=>{
        checkSource();archive.check();
        if(targetIdentity){const current=directory(destination);if(!current||!sameNode(current,targetIdentity)||!destinationLease?.isOwned())return fail('LOCK_LOST');}
      };
      const finalSourceFence=():void=>{
        check();verifyOpacityUpgradeCompanionCapture(captured,{root:source});
        for(const [file,before] of sourceFiles)if(!sameFile(before,requiredFile(file,source,file.includes('-staging/'),file===database?512*1024**2:8*1024**3)))return fail('CHANGED');
      };
      finalSourceFence();inject('afterValidation');finalSourceFence();absent(destination);
      invoke('restore','checkOfflineWorkspaceDestinationAncestors',[destination]);
      targetIdentity=identity(invoke('storage','createDestination',[destination]));directories.set(destination,targetIdentity);
      invoke('storage','syncDestinationParent',[destination]);destinationLease=acquire(destination);files.set(path.join(destination,'server.lock'),null);
      const candidate=path.join(destination,`.upgrade-${randomUUID()}.sqlite`),final=path.join(destination,'workbench.sqlite');
      const copied=await stream({file:path.join(backup,sourceDb.entry.path),root:backup,destination:candidate,destinationRoot:destination,
        private:true,maxBytes:512*1024**2,expected:sourceDb.identity,signal:options.signal,check});
      if(!copied.savedIdentity||copied.bytes!==original.bytes||copied.sha256!==original.sha256)return fail('CHANGED');
      files.set(candidate,copied.savedIdentity);ownedCandidate.set(candidate,copied.savedIdentity);
      let db:DatabaseSync|undefined;
      try {
        db=new DatabaseSync(candidate,{enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false});
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
        const pageSize=db.prepare('PRAGMA page_size').get()?.page_size;if(typeof pageSize!=='number'||pageSize<512)return fail('SOURCE_INVALID');
        db.exec(`PRAGMA max_page_count=${Math.floor(512*1024**2/pageSize)};`);
        upgradeCopiedDatabase40To42(db);check();
      } finally {
        db?.close();
        const current=inspect(candidate,destination,{allowMissing:true,private:true,maxBytes:512*1024**2});
        if(current&&sameNode(current,copied.savedIdentity))files.set(candidate,current);
      }
      invoke('restore','assertOfflineWorkspaceNoSidecars',[candidate,destination]);inject('afterDatabase');check();
      const media=path.join(destination,'media');directories.set(media,identity(invoke('storage','createNewDirectory',[media,destination])));
      for(const {entry,identity:before} of archive.files){
        if(entry.role==='database')continue;
        const output=path.join(destination,entry.path.slice('payload/'.length)),parent=path.dirname(output);
        if(!directories.has(parent))directories.set(parent,identity(invoke('storage','createNewDirectory',[parent,destination])));
        const saved=await stream({file:path.join(backup,entry.path),root:backup,destination:output,destinationRoot:destination,expected:before,
          private:true,signal:options.signal,check});
        if(!saved.savedIdentity||saved.bytes!==entry.bytes||saved.sha256!==entry.sha256)return fail('CHANGED');files.set(output,saved.savedIdentity);
      }
      inject('afterMedia');check();
      const candidateIdentity=requiredFile(candidate,destination,true,512*1024**2),lastProject=rebindOpacityUpgradeLastProject(captured,
        // options.channel binds and validates the source companion above. The
        // new copy has one explicit application launcher, whose trusted channel
        // is development; retaining the source channel would make it unreadable.
        {root:destination,channel:'development',directoryIdentity:targetIdentity,databaseIdentity:candidateIdentity});
      const write=(name:string,value:unknown,maxBytes:number):void=>{
        const file=path.join(destination,name);
        // Reuse the private writer's owned temporary inode cleanup if payload
        // fsync fails. Its best-effort directory sync is not the durable ACK:
        // explicit directory syncs below remain mandatory before activation.
        invoke('private','writePrivateFileAtomic',[file,Buffer.from(JSON.stringify(value)+'\n'),{root:destination,maxBytes,replace:false}]);
        files.set(file,requiredFile(file,destination,true,maxBytes));
      };
      if(lastProject)write('last-project-v1.json',lastProject,4096);
      const digest=await stream({file:candidate,root:destination,expected:candidateIdentity,private:true,maxBytes:512*1024**2,signal:options.signal,check});
      const proposed=opacityWorkspaceUpgradeResultSchema.parse({sourceVersion:40,targetVersion:42,profile:'ordinary',sourceBackupId:archive.backupId,
        manifestHash:archive.manifestHash,sourceDbHash:original.sha256,targetDbHash:digest.sha256,fileCount:archive.files.length,
        payloadBytes:archive.files.reduce((sum,item)=>sum+item.entry.bytes,0),preferencePolicy:'preserved',draftPolicy:'excluded-empty-only',
        taskPolicy:'settled-only',sourcePolicy:'unchanged',publication:'confirmed'});
      publication={state:'unconfirmed',sourceBackupId:proposed.sourceBackupId,manifestHash:proposed.manifestHash,sourceDbHash:proposed.sourceDbHash,targetDbHash:proposed.targetDbHash};
      const {publication:_acknowledgement,...preparedMetadata}=proposed;
      // This pre-activation record is provenance, never a success marker.
      // Only the returned ACK confirms the final link and directory fsync.
      write('UPGRADE.json',{format:'mioon-ordinary-opacity-upgrade',formatVersion:1,...preparedMetadata,record:'prepared-provenance',
        lastProjectScopeRebound:Boolean(lastProject),excludedEmptyCompanions:captured.excludedEmpty},16384);
      for(const {entry} of archive.files){if(entry.role==='database')continue;const output=path.join(destination,entry.path.slice('payload/'.length));
        const stored=await stream({file:output,root:destination,expected:files.get(output),private:true,signal:options.signal,check});
        if(stored.bytes!==entry.bytes||stored.sha256!==entry.sha256)return fail('CHANGED');}
      try {db=new DatabaseSync(candidate,{readOnly:true,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false});
        classifyWorkspaceSchema42(db);if(Object.values(db.prepare('PRAGMA quick_check(1)').get()??{})[0]!=='ok')return fail('SOURCE_INVALID');
      } finally {db?.close();db=undefined;}
      invoke('restore','assertOfflineWorkspaceNoSidecars',[candidate,destination]);
      const synced=identity(invoke('restore','syncOfflineWorkspaceFile',[candidate,destination,files.get(candidate)]));files.set(candidate,synced);
      for(const child of [...directories.keys()].sort((left,right)=>right.length-left.length))invoke('storage','syncDirectory',[child,destination]);
      invoke('storage','syncDestinationParent',[destination]);
      inject('beforePublish');
      await invoke('restore','checkOfflineWorkspaceDestinationTree',[destination,targetIdentity,files,directories,check]);
      await archive.recheck();finalSourceFence();
      for(const [file,before] of files)if(before&&!sameFile(before,requiredFile(file,destination,true,file===candidate?512*1024**2:8*1024**3)))return fail('CHANGED');
      for(const [child,before] of directories){const current=directory(child);if(!current||!sameNode(current,before))return fail('CHANGED');}
      // Exact same link/unlink+directory-fsync publication as offline restore.
      // No awaits or cancellation after this boundary starts.
      invoke('restore','publishOfflineWorkspaceCandidate',[candidate,final,destination,synced,check,()=>{attempted=true;},()=>{linked=true;}]);
      inject('afterPublish');result=proposed;return proposed;
    }]);
    result=opacityWorkspaceUpgradeResultSchema.parse(upgraded);return result;
  } catch(error) {
    const code=object(error)&&typeof error.code==='string'?error.code:'';
    operationError=linked||attempted&&code!=='EEXIST'?new OpacityWorkspaceUpgradeError('WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED'):mapped(error);
    if(operationError.code==='WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED'&&publication)operationError.publication=publication;
    throw operationError;
  } finally {
    if(destinationLease&&!destinationLease.release()){
      if(result)result.warnings=[...(result.warnings??[]),'DESTINATION_LOCK_RELEASE_UNCONFIRMED'];
      if(operationError)operationError.cleanupUnconfirmed=true;
    }
    if(operationError&&!linked&&!attempted&&target&&targetIdentity){
      let complete=true;
      for(const [file,before] of [...files].reverse()){
        if(!before)continue;
        try{
          const current=inspect(file,target,{allowMissing:true,private:true,maxBytes:ownedCandidate.has(file)?512*1024**2:8*1024**3});
          const owned=ownedCandidate.get(file);
          if(current&&owned&&sameNode(current,owned))files.set(file,current);
          if(invoke('storage','removeOwnedFile',[file,target,files.get(file)])!==true)complete=false;
        }catch{complete=false;}
      }
      for(const [child,before] of [...directories].reverse())try{invoke('storage','removeOwnedDirectory',[child,target,before]);}catch{complete=false;}
      if(!complete)operationError.cleanupUnconfirmed=true;
    }
    if(sourceLease&&!sourceLease.release()){
      if(result)result.warnings=[...(result.warnings??[]),'SOURCE_LOCK_RELEASE_UNCONFIRMED'];
      if(operationError)operationError.cleanupUnconfirmed=true;
    }
  }
}
