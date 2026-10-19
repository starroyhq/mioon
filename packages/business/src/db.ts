import {installWorkspaceEnvelopeRuntime} from './workspace-envelope-runtime.ts';
import {createWorkspaceRestoreProfileV41} from './workspace-restore-schema-v41.ts';
import {schemas} from '../../contracts/src/index.ts';
import {isTimelineRecord} from '../../contracts/src/timeline-replacement.ts';
import {isTimelineRenderRecord,TIMELINE_RENDER_RESPONSE_BYTES} from '../../contracts/src/timeline-acknowledgement.ts';
import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue} from 'node:sqlite';
import {isAsyncFunction,isPromise} from 'node:util/types';
import path from 'node:path';
import {ensurePrivateDirectory,validatePrivateDirectory,validateManagedDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {acquireWorkspaceLock} from './workspace-lock.ts';
import {initializeWorkspaceSchemaThrough24} from './workspace-fixed-schema.ts';
import {validateWorkspaceRestoreSchema,detectWorkspaceRestoreEvidence,classifyWorkspaceSchema,installWorkspaceRestoreSchema} from './workspace-restore-schema.ts';
import {createWorkspaceSchemaDispatch} from './workspace-schema-dispatch.ts';
import type {WorkspaceSchemaReader} from './workspace-schema-profile.ts';
export {validateCurrentWorkspaceColourProfile} from './workspace-schema-dispatch.ts';

/** Read contract of an opened workspace. Values cross this boundary as parsed
 * JSON (`unknown`); each domain validates its own record shape. */
export interface WorkspaceStore {
  readonly db: DatabaseSync;
  readonly root: string;
  get(table: string, id: string): unknown;
  list(table: string, projectId?: string): unknown[];
  put<T extends object>(table: string, value: T): T;
  tx<T>(callback: () => T): T;
  close(): void;
}
/** The minimum identity used by lock/restore ownership proofs. */
export interface StoreIdentity {
  readonly db: DatabaseSync;
  readonly root?: string;
}
/** Restored-workspace metadata returned only for verified restored stores. */
export interface WorkspaceRestoreContext {
  readonly schemaVersion: number;
  readonly profile: string;
  readonly workspaceOrigin: string;
  readonly restorationId?: string;
  readonly sourceBackupId?: string;
  readonly manifestHash?: string;
  readonly sourceDbHash?: string;
  readonly createdAt?: string;
  readonly sourceSchema?: number;
  readonly heldCounts?: unknown;
}

function storeUnverified(): never {const error:Error&{code?:string}=new Error('Workspace store identity is not verified');error.code='RESTORE_STORE_UNVERIFIED';throw error;}
const parseRowData=(data:unknown):unknown=>JSON.parse(typeof data==='string'?data:String(data));
const isThenable=(value:unknown):value is PromiseLike<unknown>=>value!==null&&(typeof value==='object'||typeof value==='function')&&typeof (value as {then?:unknown}).then==='function';
const sqlValue=(value:unknown):SQLInputValue=>{
  if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='bigint'||value instanceof Uint8Array)return value;
  throw new TypeError('Workspace row values must be SQLite primitives');
};

// Actual legacy predicates are assembled before any workspace can be opened.
const envelopeRestored41=createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24);
installWorkspaceEnvelopeRuntime({isTimelineRecord,isTimelineRenderRecord,
 timelineRenderResponseBytes:TIMELINE_RENDER_RESPONSE_BYTES,
 validateClipIntent:(operation,value)=>schemas[operation].safeParse(value).success,
 classify40Or41:envelopeRestored41.classifyWorkspaceSchemaV40V41,
 validateRestored41:envelopeRestored41.validateWorkspaceRestoreSchemaV41});

const workspaceSchemas=createWorkspaceSchemaDispatch({initializeThrough24:initializeWorkspaceSchemaThrough24,
 detectRestoreEvidence:detectWorkspaceRestoreEvidence,classify:classifyWorkspaceSchema,
 install:installWorkspaceRestoreSchema,validate:validateWorkspaceRestoreSchema});
export const detectCurrentWorkspaceRestoreEvidence=workspaceSchemas.detect;
export const classifyCurrentWorkspaceSchema=workspaceSchemas.classify;
export const installCurrentWorkspaceRestoreSchema=workspaceSchemas.installRestore;
export const validateCurrentWorkspaceRestoreSchema=workspaceSchemas.validateRestore;

// Backend-only proof of the actual acquired workspace lock. Neither caller
// options nor copied store properties can manufacture ownership. A replaced,
// removed or altered lock permanently revokes this handle's derivation rights.
const exclusiveOwners=new WeakMap<DatabaseSync,{root: string; lease: Readonly<{isOwned:()=>boolean;release:()=>boolean}>; active: boolean}>();
const verifiedStores=new WeakMap<StoreIdentity,{db: DatabaseSync; root: string; profile: WorkspaceRestoreContext | null}>();
export function getWorkspaceRestoreContext(store: StoreIdentity | null | undefined): WorkspaceRestoreContext | null {
 const verified=store?verifiedStores.get(store):undefined,db=store?.db;
 // Ordinary wrappers and established direct native-DB consumers remain valid.
 // Always bypass caller-overridden methods for this absence proof. A copied or
 // fake schema25 store can never manufacture the exact registered capability.
 const scan={prepare:(sql:string)=>Reflect.apply(DatabaseSync.prototype.prepare,db,[sql]) as ReturnType<WorkspaceSchemaReader['prepare']>};
 let restored: boolean;
 try{restored=detectCurrentWorkspaceRestoreEvidence(scan as WorkspaceSchemaReader);}catch{return storeUnverified();}
 if(!restored){if(verified?.profile)return storeUnverified();return null;}
 if(!verified||verified.profile===null||db!==verified.db||store?.root!==verified.root||verified.db.isOpen!==true)return storeUnverified();
 return verified.profile;
}
export function ownsStoreLock(store: StoreIdentity | null | undefined): boolean {
 const db=store?.db,owner=db?exclusiveOwners.get(db):undefined;
 if(!owner||!db||!owner.active||store?.root!==owner.root||db.isOpen!==true)return false;
 if(owner.lease.isOwned())return true;
 owner.active=false;exclusiveOwners.delete(db);return false;
}

/** Read-only preflight of every startup-owned entry, before any lock, token,
 * directory or SQLite write. Legacy 0755 media and 0644 SQLite remain protected
 * by the verified 0700 root, provided no other account can write them. */
export function validateWorkspaceStorage(root: string): void {
 root=path.resolve(root);
 if(!validatePrivateDirectory(root,{allowMissing:true}))return;
 validateManagedDirectory(path.join(root,'media'),{root,allowMissing:true});
 validateManagedDirectory(path.join(root,'image-staging'),{root,allowMissing:true,private:true});
 validateManagedDirectory(path.join(root,'frame-staging'),{root,allowMissing:true,private:true});
 for(const name of ['workbench.sqlite','workbench.sqlite-wal','workbench.sqlite-shm','workbench.sqlite-journal']){
  validateManagedFile(path.join(root,name),{root,allowMissing:true});
 }
 validateManagedFile(path.join(root,'server.lock'),{root,allowMissing:true,maxBytes:64});
 validateManagedFile(path.join(root,'access-token'),{root,allowMissing:true,private:true,maxBytes:4098});
  validateManagedFile(path.join(root,'local-drafts-v1.json'),{root,allowMissing:true,private:true,maxBytes:2*1024*1024});
 for(const name of ['agent-settings','image-settings','comfy-settings']){
  const settings=path.join(root,name);
  if(validateManagedDirectory(settings,{root,allowMissing:true,private:true})){
   for(const filename of name==='image-settings'?['settings.json','custom-settings.json']:['settings.json'])
    validateManagedFile(path.join(settings,filename),{root,allowMissing:true,private:true,maxBytes:name==='comfy-settings'?16*1024:64*1024});
  }
 }
}

export function openStore(root: string,{lock=true}: {lock?: boolean} = {}): WorkspaceStore {
 root=path.resolve(root);
 validateWorkspaceStorage(root);
 ensurePrivateDirectory(root,{create:true});
 validateWorkspaceStorage(root);
 let db: DatabaseSync | undefined,ownedLock: ReturnType<typeof acquireWorkspaceLock> | undefined;
 const releaseLock=():void=>{ownedLock?.release();ownedLock=undefined;};
 try{
  if(lock)ownedLock=acquireWorkspaceLock(root,{allowStale:true});
  // Recheck immediately before SQLite's pathname-only open. Node has no SQLite
  // fd/NOFOLLOW API; a concurrent same-uid/root adversary is outside this policy.
  validateWorkspaceStorage(root);
  const database=new DatabaseSync(path.join(root,'workbench.sqlite'));
  db=database;
  database.exec('PRAGMA trusted_schema=OFF;');
  if(database.prepare('PRAGMA trusted_schema').get()?.trusted_schema!==0)throw new Error('Trusted schema must be disabled');
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 // The typed dispatcher retains old through24 repair and fixed restored25;
 // explicit ordinary26/restored27 roles never fall through to legacy bootstrap.
 const restoreContext=workspaceSchemas.initialize(database);
 if(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1)throw new Error('Foreign-key enforcement must be enabled');
 const tables=new Set(['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines']);
 const table=(t: string): string=>{if(!tables.has(t))throw Error('Unknown table');return t;};
 const get=(t: string,id: string): unknown=>{const r=database.prepare(`SELECT data FROM ${table(t)} WHERE id=?`).get(id);return r?parseRowData(r.data):null;};
 const list=(t: string,p?: string): unknown[]=>{
  const rows=p?database.prepare(`SELECT data FROM ${table(t)} WHERE projectId=?`).all(p):database.prepare(`SELECT data FROM ${table(t)}`).all();
  return rows.map(r=>parseRowData(r.data));
 };
 const put=<T extends object>(t: string,obj: T): T=>{table(t);const cols=t==='projects'?['id','data']:t==='versions'?['id','projectId','jobId','data']:['id','projectId','data'];const record=obj as Readonly<Record<string,unknown>>;const values=cols.map(k=>k==='data'?JSON.stringify(obj):sqlValue(record[k]));database.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(...values);return obj;};
 // A transaction owns its complete synchronous callback. Never commit before
 // asynchronous work, or let a nested caller roll back an outer transaction.
 const tx=<T>(fn: () => T): T=>{
  if(typeof fn!=='function'||isAsyncFunction(fn))throw new TypeError('Transactions require a synchronous callback');
  if(database.isTransaction)throw new Error('Nested transactions are not supported');
  database.exec('BEGIN IMMEDIATE');
  try{
   const result=fn();
   if(isThenable(result)){
    if(isPromise(result))Promise.resolve(result).catch(()=>{});
    throw new TypeError('Transactions require a synchronous result');
   }
   database.exec('COMMIT');return result;
  }catch(error){if(database.isTransaction)database.exec('ROLLBACK');throw error;}
 };
 // Do not create media until the complete preflight and schema initialization
 // succeed. Existing safe legacy media permissions are deliberately preserved.
 if(!validateManagedDirectory(path.join(root,'media'),{root,allowMissing:true}))ensurePrivateDirectory(path.join(root,'media'),{create:true});
 if(ownedLock)exclusiveOwners.set(database,{root,lease:ownedLock,active:true});
 let closed=false;
 const close=():void=>{
  if(closed)return;
  const owner=exclusiveOwners.get(database);if(owner)owner.active=false;exclusiveOwners.delete(database);
  database.close();closed=true;releaseLock();
 };
 const store: WorkspaceStore={db:database,root,get,list,put,tx,close};
 verifiedStores.set(store,{db:database,root,profile:restoreContext as WorkspaceRestoreContext | null});
 return store;
 }catch(error){
  if(db)exclusiveOwners.delete(db);
  try{db?.close();}catch{}
  releaseLock();
  throw error;
 }
}
