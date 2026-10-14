import {DatabaseSync} from 'node:sqlite';
import {isAsyncFunction,isPromise} from 'node:util/types';
import path from 'node:path';
import {ensurePrivateDirectory,validatePrivateDirectory,validateManagedDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {acquireWorkspaceLock} from './workspace-lock.mjs';
import {initializeWorkspaceSchemaThrough24} from './workspace-fixed-schema.mjs';
import {validateWorkspaceRestoreSchema,detectWorkspaceRestoreEvidence,classifyWorkspaceSchema,installWorkspaceRestoreSchema} from './workspace-restore-schema.mjs';
import {createWorkspaceSchemaDispatch} from './workspace-schema-dispatch.ts';

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
const exclusiveOwners=new WeakMap();
const verifiedStores=new WeakMap();
export function getWorkspaceRestoreContext(store){
 const verified=store&&verifiedStores.get(store),db=store?.db;
 // Ordinary wrappers and established direct native-DB consumers remain valid.
 // Always bypass caller-overridden methods for this absence proof. A copied or
 // fake schema25 store can never manufacture the exact registered capability.
 const scan={prepare:sql=>Reflect.apply(DatabaseSync.prototype.prepare,db,[sql])};
 let restored;try{restored=detectCurrentWorkspaceRestoreEvidence(scan);}catch{const error=new Error('Workspace store identity is not verified');error.code='RESTORE_STORE_UNVERIFIED';throw error;}
 if(!restored){if(verified?.profile){const error=new Error('Workspace restoration profile disappeared');error.code='RESTORE_STORE_UNVERIFIED';throw error;}return null;}
 if(!verified||verified.profile===null||db!==verified.db||store.root!==verified.root||verified.db.isOpen!==true){const error=new Error('Workspace store identity is not verified');error.code='RESTORE_STORE_UNVERIFIED';throw error;}
 return verified.profile;
}
export function ownsStoreLock(store){
 const db=store?.db,owner=db&&exclusiveOwners.get(db);
 if(!owner||!owner.active||store.root!==owner.root||db.isOpen!==true)return false;
 if(owner.lease.isOwned())return true;
 owner.active=false;exclusiveOwners.delete(db);return false;
}

/** Read-only preflight of every startup-owned entry, before any lock, token,
 * directory or SQLite write. Legacy 0755 media and 0644 SQLite remain protected
 * by the verified 0700 root, provided no other account can write them. */
export function validateWorkspaceStorage(root){
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

export function openStore(root,{lock=true}={}){
 root=path.resolve(root);
 validateWorkspaceStorage(root);
 ensurePrivateDirectory(root,{create:true});
 validateWorkspaceStorage(root);
 let db,ownedLock;
 const releaseLock=()=>{ownedLock?.release();ownedLock=undefined;};
 try{
  if(lock)ownedLock=acquireWorkspaceLock(root,{allowStale:true});
  // Recheck immediately before SQLite's pathname-only open. Node has no SQLite
  // fd/NOFOLLOW API; a concurrent same-uid/root adversary is outside this policy.
  validateWorkspaceStorage(root);
  db=new DatabaseSync(path.join(root,'workbench.sqlite'));
  db.exec('PRAGMA trusted_schema=OFF;');
  if(db.prepare('PRAGMA trusted_schema').get().trusted_schema!==0)throw new Error('Trusted schema must be disabled');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 // The typed dispatcher retains old through24 repair and fixed restored25;
 // explicit ordinary26/restored27 roles never fall through to legacy bootstrap.
 const restoreContext=workspaceSchemas.initialize(db);
 if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)throw new Error('Foreign-key enforcement must be enabled');
 const tables=new Set(['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines']);
 const table=t=>{if(!tables.has(t))throw Error('Unknown table');return t;};
 const get=(t,id)=>{const r=db.prepare(`SELECT data FROM ${table(t)} WHERE id=?`).get(id);return r?JSON.parse(r.data):null;};
 const list=(t,p)=>db.prepare(`SELECT data FROM ${table(t)}${p?' WHERE projectId=?':''}`).all(...p?[p]:[]).map(r=>JSON.parse(r.data));
 const put=(t,obj)=>{table(t);const cols=t==='projects'?['id','data']:t==='versions'?['id','projectId','jobId','data']:['id','projectId','data'];const values=cols.map(k=>k==='data'?JSON.stringify(obj):obj[k]);db.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(...values);return obj;};
 // A transaction owns its complete synchronous callback. Never commit before
 // asynchronous work, or let a nested caller roll back an outer transaction.
 const tx=fn=>{
  if(typeof fn!=='function'||isAsyncFunction(fn))throw new TypeError('Transactions require a synchronous callback');
  if(db.isTransaction)throw new Error('Nested transactions are not supported');
  db.exec('BEGIN IMMEDIATE');
  try{
   const result=fn();
   if(result&&typeof result.then==='function'){
    if(isPromise(result))result.catch(()=>{});
    throw new TypeError('Transactions require a synchronous result');
   }
   db.exec('COMMIT');return result;
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 };
 // Do not create media until the complete preflight and schema initialization
 // succeed. Existing safe legacy media permissions are deliberately preserved.
 if(!validateManagedDirectory(path.join(root,'media'),{root,allowMissing:true}))ensurePrivateDirectory(path.join(root,'media'),{create:true});
 if(ownedLock)exclusiveOwners.set(db,{root,lease:ownedLock,active:true});
 let closed=false;
 const close=()=>{
  if(closed)return;
  const owner=exclusiveOwners.get(db);if(owner)owner.active=false;exclusiveOwners.delete(db);
  db.close();closed=true;releaseLock();
 };
 const store={db,root,get,list,put,tx,close};
 verifiedStores.set(store,{db,root,profile:restoreContext});
 return store;
 }catch(error){
  if(db)exclusiveOwners.delete(db);
  try{db?.close();}catch{}
  releaseLock();
  throw error;
 }
}
