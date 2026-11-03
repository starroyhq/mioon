import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {assertProjectDatabase} from '../../packages/business/src/store-runtime.ts';

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
/** A bounded, synchronous corruption probe on the actual held kernel connection.
 * Only named immutable guards are suspended. Their canonical SQL is restored
 * before the reader runs; the connection and all ownership guards stay real. */
export function withNativeTriggerFault<T>(db:DatabaseSync,schema:'main'|'project'|'cache',names:readonly string[],write:()=>T):T {
 assertProjectDatabase(db);
 const guards=names.map(name=>{
  const row=db.prepare(`SELECT sql FROM ${quote(schema)}.sqlite_schema WHERE type='trigger' AND name=?`).get(name);
  assert.equal(typeof row?.sql,'string',`${schema}.${name}: actual canonical guard exists`);
  return {name,sql:row!.sql as string};
 });
 for(const guard of guards)db.exec(`DROP TRIGGER ${quote(schema)}.${quote(guard.name)}`);
 try{return write();}
 finally{
  for(const guard of guards){
   db.exec(guard.sql.replace(/^CREATE TRIGGER\s+/u,`CREATE TRIGGER ${quote(schema)}.`));
   assert.equal(db.prepare(`SELECT sql FROM ${quote(schema)}.sqlite_schema WHERE type='trigger' AND name=?`).get(guard.name)?.sql,guard.sql,`${schema}.${guard.name}: canonical guard restored exactly`);
  }
 }
}
