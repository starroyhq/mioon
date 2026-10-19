import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isAsyncFunction,isPromise} from 'node:util/types';
import {initializeLegacyWorkspaceSchema} from '../../packages/business/src/workspace-fixed-schema.ts';

// Test-only adapter for isolated, application-owned historical fixtures. Seed
// with the immutable through24 constructor; the production openStore remains
// the migration under test. Never manufacture legacy data by downgrading a
// current edit_tasks table or by removing a current schema marker.
export interface LegacyWorkspaceStore {readonly db: DatabaseSync; readonly root: string;
 get(name: string,id: string): unknown; list(name: string,projectId?: string): unknown[];
 put(name: string,object: Record<string, unknown>): Record<string, unknown>;
 tx<T>(work: ()=>T): T; close(): void}
export function openLegacyWorkspaceStore(root: string): LegacyWorkspaceStore {
 root=path.resolve(root);
 mkdirSync(root,{recursive:true,mode:0o700});
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));
 try {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_version'").get())
   assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version NOT BETWEEN 1 AND 24 LIMIT 1').get(),undefined,'legacy fixtures cannot reopen current or restored workspaces');
  initializeLegacyWorkspaceSchema(db);
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),Array.from({length:24},(_,index)=>index+1));
  mkdirSync(path.join(root,'media'),{recursive:true,mode:0o700});
  const tables=new Set(['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines']);
  const table=(name: string): string=>{if(!tables.has(name))throw Error('Unknown table');return name;};
  const get=(name: string,id: string)=>{const row=db.prepare(`SELECT data FROM ${table(name)} WHERE id=?`).get(id) as {data: string}|undefined;return row?JSON.parse(row.data):null;};
  const list=(name: string,projectId?: string)=>(db.prepare(`SELECT data FROM ${table(name)}${projectId?' WHERE projectId=?':''}`).all(...projectId?[projectId]:[]) as {data: string}[]).map(row=>JSON.parse(row.data));
  const put=(name: string,object: Record<string, unknown>): Record<string, unknown>=>{
   table(name);
   const columns=name==='projects'?['id','data']:name==='versions'?['id','projectId','jobId','data']:['id','projectId','data'];
   db.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(...columns.map(key=>key==='data'?JSON.stringify(object):object[key] as string));
   return object;
  };
  const tx=<T>(fn: ()=>T): T=>{
   if(typeof fn!=='function'||isAsyncFunction(fn))throw new TypeError('Transactions require a synchronous callback');
   if(db.isTransaction)throw new Error('Nested transactions are not supported');
   db.exec('BEGIN IMMEDIATE');
   try {
    const result=fn();
    if(result&&typeof (result as {then?: unknown}).then==='function'){
     if(isPromise(result))(result as Promise<unknown>).catch(()=>{});
     throw new TypeError('Transactions require a synchronous result');
    }
    db.exec('COMMIT');return result;
   } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  };
  const close=()=>{if(db.isOpen)db.close();};
  return {db,root,get,list,put,tx,close};
 } catch(error) {db.close();throw error;}
}
