import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite';
import {AppError} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {WORKSPACE_BACKUP_LIMITS} from '../../contracts/src/workspace-backup.ts';
import {workspaceBackupIndexSchema as indexSchema,workspaceActivationSchema as activationSchema,workspaceBackupStatusSchema,workspaceConfigurationSchemas,type WorkspaceBackupEntry,type WorkspaceBackupStatus,type WorkspaceBackupIndex as Index} from '../../contracts/src/workspace-configuration.ts';
import type {WorkspaceConfiguration} from './workspace-configuration.ts';
import {type WorkspaceStore,ownsStoreLock,getWorkspaceRestoreContext} from './db.ts';
import {inspectWorkspaceBackup} from './backup-readiness.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from './workspace-backup.ts';
import {buildWorkspaceInventory,createIssueCollector} from './workspace-backup-inventory.ts';
import {restoreWorkspaceBackup,inspectWorkspaceRestorePublication} from './workspace-restore.ts';
import {exportWorkspaceBackupBundle,importWorkspaceBackupBundle} from './workspace-backup-bundle.ts';
import {checkSeparate,createDestination,createNewDirectory,inspectFile,streamFile,writeBoundedFile,removeOwnedFile,removeOwnedDirectory} from './workspace-backup-storage.ts';
import type {Stats} from 'node:fs';

const INDEX='workspace-backups-index-v1.json',ACTIVATION='workspace-activation-v1.json',MAX_INDEX=128*1024;
const failure=(code:string)=>new AppError(code,'Workspace backup could not complete safely.',409);
const safeCode=(error:unknown)=>{const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'WORKSPACE_BACKUP_IO';};
function readJson<T>(root:string,name:string,schema:{parse(value:unknown):T},fallback:T):T {
  const raw=readPrivateFile(path.join(root,name),{root,maxBytes:MAX_INDEX,allowMissing:true,encoding:'utf8'});
  if(raw===null)return fallback;
  try{return schema.parse(JSON.parse(String(raw)));}catch{throw failure('WORKSPACE_BACKUP_STATE_INVALID');}
}
function readActivation(root:string){return readJson(root,ACTIVATION,activationSchema.nullable(),null);}

/** Called before opening any Store. Activation chooses a separate, verified
 * guarded workspace; it never replaces the original database or credentials. */
export async function resolveWorkspaceActivation(baseRoot:string):Promise<{baseRoot:string;root:string;restored:boolean}> {
  baseRoot=path.resolve(baseRoot);
  if(!validatePrivateDirectory(baseRoot,{allowMissing:true}))return {baseRoot,root:baseRoot,restored:false};
  const pointer=readActivation(baseRoot);
  if(!pointer)return {baseRoot,root:baseRoot,restored:false};
  checkSeparate(baseRoot,pointer.destination);
  await inspectWorkspaceRestorePublication({destination:pointer.destination,restorationId:pointer.restorationId,sourceBackupId:pointer.sourceBackupId,manifestHash:pointer.manifestHash,sourceDbHash:pointer.sourceDbHash});
  if(pointer.state==='pending')writePrivateFileAtomic(path.join(baseRoot,ACTIVATION),JSON.stringify({...pointer,state:'active'}),{root:baseRoot,maxBytes:MAX_INDEX});
  return {baseRoot,root:pointer.destination,restored:true};
}

export function createWorkspaceBackupRuntime({store,configuration,isQuiescent=()=>true,now=Date.now}:{store:WorkspaceStore;configuration:WorkspaceConfiguration;isQuiescent?:()=>boolean;now?:()=>number}) {
  const root=configuration.root,empty:Index={formatVersion:1,entries:[],nextBackupAt:null,lastError:null};
  let phase:WorkspaceBackupStatus['phase']='idle',stopped=true,timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<unknown>|null=null,controller:AbortController|null=null;
  const readIndex=()=>readJson(root,INDEX,indexSchema,empty);
  const saveIndex=(value:Index)=>writePrivateFileAtomic(path.join(root,INDEX),JSON.stringify(indexSchema.parse(value)),{root,maxBytes:MAX_INDEX});
  const publicEntry=({directory:_,...entry}:Index['entries'][number]):WorkspaceBackupEntry=>entry;
  const assertOwner=(requireQuiescence=false)=>{
    // A retained read transaction can hide external commits from data_version.
    // Maintenance must observe the current connection state between chunks.
    if(!ownsStoreLock(store)||store.db.isTransaction||getWorkspaceRestoreContext(store)||requireQuiescence&&!isQuiescent())throw failure('WORKSPACE_BACKUP_BUSY');
  };
  const assertIdle=(requireQuiescence=true)=>{
    assertOwner(requireQuiescence);
    const report=inspectWorkspaceBackup(store);
    if(!report.inspectionComplete||Object.values(report.unresolved).some(value=>value!==0))throw failure('WORKSPACE_BACKUP_BUSY');
    // Legacy cold capture preserves cancelled paid work as evidence. Online
    // maintenance additionally refuses it until the original result is known;
    // a local task-list disposition cannot turn this row into safe idleness.
    const cancelledPaid=store.db.prepare(`SELECT 1 FROM jobs WHERE json_valid(data) AND json_extract(data,'$.status')='cancelled' AND ((json_type(data,'$.providerJobId')='text' AND length(json_extract(data,'$.providerJobId'))>0) OR (json_type(data,'$.submissionCount') IN ('integer','real') AND json_extract(data,'$.submissionCount')>0)) LIMIT 1`).get();
    if(cancelledPaid)throw failure('WORKSPACE_BACKUP_BUSY');
  };
  const fingerprint=()=>`${store.db.prepare('SELECT CAST(total_changes() AS TEXT) AS n').get()?.n}:${store.db.prepare('PRAGMA main.schema_version').get()?.schema_version}:${store.db.prepare('PRAGMA main.data_version').get()?.data_version}`;
  // The full admission belongs only to this queued operation. Reuse it between
  // phase boundaries while every progress/chunk still checks the owner and all
  // three change counters. data_version also detects another connection's
  // committed data writes, which total_changes cannot see. Never refresh the
  // original stamp after a change or turn revalidation into permission to retry.
  const assertCurrent=(stamp:string,signal:AbortSignal)=>{signal.throwIfAborted();assertOwner();if(fingerprint()!==stamp)throw failure('WORKSPACE_BACKUP_CHANGED');};
  const admit=(signal:AbortSignal)=>{signal.throwIfAborted();assertOwner();const stamp=fingerprint();assertIdle();assertCurrent(stamp,signal);return stamp;};
  const assertValidatedCurrent=(stamp:string,signal:AbortSignal)=>{assertCurrent(stamp,signal);assertIdle(false);assertCurrent(stamp,signal);};
  const ensureDirectory=()=>{
    const directory=configuration.get().backupDirectory;checkSeparate(store.root,directory);checkSeparate(root,directory);
    if(!validatePrivateDirectory(directory,{allowMissing:true}))createDestination(directory);
    return directory;
  };
  const queue=<T>(nextPhase:Exclude<WorkspaceBackupStatus['phase'],'idle'>,work:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    if(phase!=='idle')return Promise.reject(failure('WORKSPACE_BACKUP_BUSY'));
    phase=nextPhase;controller=new AbortController();
    const task=Promise.resolve().then(()=>work(controller!.signal)).catch(error=>{
      const index=readIndex();saveIndex({...index,lastError:safeCode(error)});throw error;
    }).finally(()=>{phase='idle';controller=null;pending=null;});
    pending=task;return task;
  };
  const create=(input:{requestId:string},trigger:'manual'|'automatic'='manual'):Promise<WorkspaceBackupEntry>=>{
    input=workspaceConfigurationSchemas['workspace.backup.create'].parse(input);
    const existing=readIndex().entries.find(entry=>entry.requestId===input.requestId);
    if(existing)return existing.trigger===trigger?Promise.resolve(publicEntry(existing)):Promise.reject(failure('WORKSPACE_BACKUP_IDEMPOTENCY_CONFLICT'));
    return queue('creating',async signal=>{
      const stamp=admit(signal),index=readIndex();if(index.entries.length>=100)throw failure('WORKSPACE_BACKUP_LIMIT');
      if(readActivation(root))throw failure('WORKSPACE_RESTORE_PENDING');
      const directory=ensureDirectory(),id=randomUUID(),snapshot=path.join(directory,`.snapshot-${id}`),snapshotIdentity=createDestination(snapshot),destination=path.join(directory,id);
      const ownedFiles=new Map<string,Stats>(),ownedDirectories=new Map<string,Stats>();let snapshotDb:DatabaseSync|undefined;
      const database=path.join(snapshot,'workbench.sqlite');
      try{
        writeBoundedFile(database,snapshot,Buffer.alloc(0),WORKSPACE_BACKUP_LIMITS.databaseBytes);
        try{await sqliteBackup(store.db,database,{rate:128,progress:()=>assertCurrent(stamp,signal)});}
        catch(error){
          // SQLite can reject before its next JS progress callback. Recheck the
          // frozen source on failure too; an unchanged source keeps its native
          // error, and neither path retries the backup.
          assertCurrent(stamp,signal);throw error;
        }
        assertValidatedCurrent(stamp,signal);
        const databaseIdentity=inspectFile(database,snapshot,{private:true,maxBytes:WORKSPACE_BACKUP_LIMITS.databaseBytes})!;ownedFiles.set(database,databaseIdentity);
        // Normalize only our newly created snapshot, never the active WAL.
        snapshotDb=new DatabaseSync(database);snapshotDb.exec('PRAGMA journal_mode=DELETE; PRAGMA trusted_schema=OFF;');
        const databaseCopy=await streamFile({file:database,root:snapshot,private:true,maxBytes:WORKSPACE_BACKUP_LIMITS.databaseBytes,signal,check:()=>assertCurrent(stamp,signal)});
        const issues=createIssueCollector(),inventory=await buildWorkspaceInventory({db:snapshotDb,source:store.root,signal,check:()=>assertCurrent(stamp,signal),issues,databaseEntry:{path:'payload/workbench.sqlite',role:'database',bytes:databaseCopy.bytes,sha256:databaseCopy.sha256}});
        if(!issues.result().complete)throw failure('WORKSPACE_BACKUP_INCOMPLETE');
        assertValidatedCurrent(stamp,signal);
        snapshotDb.close();snapshotDb=undefined;
        ownedFiles.set(database,inspectFile(database,snapshot,{private:true,maxBytes:WORKSPACE_BACKUP_LIMITS.databaseBytes})!);
        for(const entry of inventory.plan){
          assertCurrent(stamp,signal);const output=path.join(snapshot,entry.relative),parent=path.dirname(output);
          if(!ownedDirectories.has(parent))ownedDirectories.set(parent,createNewDirectory(parent,snapshot));
          const copied=await streamFile({file:path.join(store.root,entry.relative),root:store.root,destination:output,destinationRoot:snapshot,private:entry.relative.includes('-staging/'),expected:entry.identity,signal,check:()=>assertCurrent(stamp,signal),cleanupOnFailure:true});
          if(entry.sha256&&copied.sha256!==entry.sha256||entry.bytes!==undefined&&copied.bytes!==entry.bytes)throw failure('WORKSPACE_BACKUP_CHANGED');
          ownedFiles.set(output,copied.savedIdentity!);
        }
        assertValidatedCurrent(stamp,signal);const result=await createWorkspaceBackup({source:snapshot,destination,signal});
        assertValidatedCurrent(stamp,signal);await verifyWorkspaceBackup({directory:destination,signal});assertValidatedCurrent(stamp,signal);
        const entry={id,createdAt:new Date(now()).toISOString(),fileCount:result.fileCount,payloadBytes:result.payloadBytes,trigger,requestId:input.requestId,directory:destination};
        saveIndex({...readIndex(),entries:[...readIndex().entries,entry],lastError:null,nextBackupAt:configuration.get().automaticBackup?new Date(now()+configuration.get().backupIntervalHours*3600_000).toISOString():null});
        return publicEntry(entry);
      }finally{
        snapshotDb?.close();
        // Only exact files/directories created by this operation are removed.
        // Interrupted or changed candidates are retained for local inspection.
        for(const [file,identity] of [...ownedFiles].reverse())removeOwnedFile(file,snapshot,identity);
        for(const [directory,identity] of [...ownedDirectories].reverse())removeOwnedDirectory(directory,snapshot,identity);
        try{removeOwnedDirectory(snapshot,snapshot,snapshotIdentity);}catch{/* Unowned/incomplete files remain private; no recursive deletion. */}
      }
    });
  };
  const stageRestore=(input:{requestId:string;backupId:string;confirmation:'RESTORE_BACKUP'})=>{
    input=workspaceConfigurationSchemas['workspace.backup.restore.stage'].parse(input);
    const pointer=readActivation(root);
    if(pointer?.requestId===input.requestId){if(pointer.backupId!==input.backupId)return Promise.reject(failure('WORKSPACE_BACKUP_IDEMPOTENCY_CONFLICT'));return Promise.resolve({requestId:pointer.requestId,backupId:pointer.backupId,state:pointer.state,restartRequired:pointer.state==='pending'});}
    return queue('restoring',async signal=>{
      const stamp=admit(signal);if(pointer)throw failure('WORKSPACE_RESTORE_PENDING');
      const entry=readIndex().entries.find(value=>value.id===input.backupId);if(!entry)throw failure('WORKSPACE_BACKUP_NOT_FOUND');
      await verifyWorkspaceBackup({directory:entry.directory,signal});assertValidatedCurrent(stamp,signal);
      const destination=path.join(path.dirname(entry.directory),`restored-${randomUUID()}`);
      const result=await restoreWorkspaceBackup({directory:entry.directory,destination,signal});assertValidatedCurrent(stamp,signal);
      const activation=activationSchema.parse({formatVersion:1,state:'pending',requestId:input.requestId,backupId:input.backupId,destination,restorationId:result.restorationId,sourceBackupId:result.sourceBackupId,manifestHash:result.manifestHash,sourceDbHash:result.sourceDbHash});
      await inspectWorkspaceRestorePublication({destination,restorationId:activation.restorationId,sourceBackupId:activation.sourceBackupId,manifestHash:activation.manifestHash,sourceDbHash:activation.sourceDbHash,signal});assertValidatedCurrent(stamp,signal);
      writePrivateFileAtomic(path.join(root,ACTIVATION),JSON.stringify(activation),{root,maxBytes:MAX_INDEX});
      saveIndex({...readIndex(),lastError:null});
      return {requestId:input.requestId,backupId:input.backupId,state:'pending' as const,restartRequired:true};
    });
  };
  const exportBundle=(backupId:string,signal?:AbortSignal)=>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(backupId))throw failure('WORKSPACE_BACKUP_NOT_FOUND');
    const entry=readIndex().entries.find(value=>value.id===backupId);if(!entry)throw failure('WORKSPACE_BACKUP_NOT_FOUND');
    return exportWorkspaceBackupBundle({directory:entry.directory,signal});
  };
  const importBundle=(source:AsyncIterable<Uint8Array>,input:{requestId:string})=>{
    input=workspaceConfigurationSchemas['workspace.backup.create'].parse(input);
    const existing=readIndex().entries.find(entry=>entry.requestId===input.requestId);if(existing)return existing.trigger==='import'?Promise.resolve(publicEntry(existing)):Promise.reject(failure('WORKSPACE_BACKUP_IDEMPOTENCY_CONFLICT'));
    return queue('importing',async signal=>{
      const stamp=admit(signal),index=readIndex();if(index.entries.length>=100)throw failure('WORKSPACE_BACKUP_LIMIT');
      if(readActivation(root))throw failure('WORKSPACE_RESTORE_PENDING');
      const directory=ensureDirectory(),id=randomUUID(),destination=path.join(directory,id);createDestination(destination);
      const result=await importWorkspaceBackupBundle({source,destination,signal,check:()=>assertCurrent(stamp,signal)});assertValidatedCurrent(stamp,signal);
      const entry={id,createdAt:new Date(now()).toISOString(),fileCount:result.fileCount,payloadBytes:result.payloadBytes,trigger:'import' as const,requestId:input.requestId,directory:destination};
      saveIndex({...readIndex(),entries:[...readIndex().entries,entry],lastError:null});return publicEntry(entry);
    });
  };
  const status=():WorkspaceBackupStatus=>{
    const index=readIndex(),settings=configuration.get(),pointer=readActivation(root);
    return workspaceBackupStatusSchema.parse({phase,directory:settings.backupDirectory,automatic:settings.automaticBackup,intervalHours:settings.backupIntervalHours,lastBackupAt:index.entries.at(-1)?.createdAt??null,nextBackupAt:settings.automaticBackup?index.nextBackupAt:null,lastError:index.lastError,backups:index.entries.map(publicEntry).reverse(),pendingRestore:pointer?{requestId:pointer.requestId,backupId:pointer.backupId,state:pointer.state,restartRequired:pointer.state==='pending'}:null});
  };
  const schedule=()=>{
    if(timer)clearTimeout(timer);timer=undefined;if(stopped)return;
    try{const settings=configuration.get(),index=readIndex();if(settings.automaticBackup&&!index.nextBackupAt)saveIndex({...index,nextBackupAt:new Date(now()+settings.backupIntervalHours*3600_000).toISOString()});}
    catch{stopped=true;return;}
    timer=setTimeout(()=>{timer=undefined;void tick().then(schedule,()=>{stopped=true;});},60_000);timer.unref?.();
  };
  const tick=async()=>{
    if(stopped||phase!=='idle')return;const settings=configuration.get(),index=readIndex();
    if(!settings.automaticBackup||!index.nextBackupAt||now()<Date.parse(index.nextBackupAt)||readActivation(root))return;
    try{assertIdle();}catch{return;}
    saveIndex({...index,nextBackupAt:new Date(now()+settings.backupIntervalHours*3600_000).toISOString()});
    try{await create({requestId:randomUUID()},'automatic');}catch{/* Accurate bounded error is persisted by the queue; no automatic retry. */}
  };
  let previousSettings=configuration.get();
  const unsubscribe=configuration.subscribe(()=>{const settings=configuration.get();if(settings.automaticBackup!==previousSettings.automaticBackup||settings.backupIntervalHours!==previousSettings.backupIntervalHours){const index=readIndex();saveIndex({...index,nextBackupAt:settings.automaticBackup?new Date(now()+settings.backupIntervalHours*3600_000).toISOString():null});}previousSettings=settings;schedule();});
  return {
    getStatus:status,list:()=>status().backups,create,stageRestore,exportBundle,importBundle,
    importDirectory:(directory:string,input:{requestId:string})=>{checkSeparate(store.root,directory);return importBundle(exportWorkspaceBackupBundle({directory}),input);},
    isBusy:()=>phase!=='idle',
    assertMutationAllowed():void {if(phase!=='idle')throw failure('WORKSPACE_BACKUP_BUSY');if(readActivation(root))throw failure('WORKSPACE_RESTORE_PENDING');},
    start():void {stopped=false;schedule();},
    stop():void {stopped=true;if(timer)clearTimeout(timer);timer=undefined;controller?.abort();unsubscribe();},
    async drain():Promise<void> {await pending?.catch(()=>{});},
    tick,
  };
}
export type WorkspaceBackupRuntime=ReturnType<typeof createWorkspaceBackupRuntime>;
