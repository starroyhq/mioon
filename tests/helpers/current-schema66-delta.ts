import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
interface CurrentOrdinary66Delta {
 readonly schemaVersionRows:readonly (readonly string[])[];readonly objects:readonly SchemaObject[];
 readonly tables:Readonly<Record<string,{fields:readonly string[];rows:0}>>;readonly catalog:{count:number;sha256:string};
}
/** Independently reviewed conversation policy and question additions
 * (schema66): the per-conversation confirmation policy table and its request
 * receipts with their guards. Runs and steps waiting for an answer reuse the
 * existing tables. Frozen in tests/fixtures/workspace-schema-profiles/current-ordinary-66-delta.json.
 * Reviewed64 catalogs are unchanged once these exact definitions are excluded. */
export const currentOrdinary66Delta:CurrentOrdinary66Delta=JSON.parse(readFileSync(
 new URL('../fixtures/workspace-schema-profiles/current-ordinary-66-delta.json',import.meta.url),'utf8'));
const names=new Set(currentOrdinary66Delta.objects.map(object=>object.name));
export function withoutReviewedPolicyAnswerObjects<T extends SchemaObject>(objects:readonly T[]):T[] {
 const additions=objects.filter(object=>names.has(object.name));
 if(!additions.length)return [...objects];
 assert.deepEqual(additions.map(object=>({type:object.type,name:object.name,tbl_name:object.tbl_name,sql:object.sql})),currentOrdinary66Delta.objects,'independent reviewed66 policy and answer SQL');
 return objects.filter(object=>!names.has(object.name));
}
/** Build genuine64 fixture bytes only when no conversation policy rows and no
 * run or step waiting for an answer exist. Newer layers go first; use
 * downgradeReviewedWorkspace from reviewed-schema-layers.ts. */
export function removeReviewedSchema66(db:DatabaseSync):void {
 if(!db.prepare('SELECT 1 FROM schema_version WHERE version=66').get())return;
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>66').get(),undefined,'newer reviewed layers are removed first');
 const tables=Object.keys(currentOrdinary66Delta.tables);
 for(const table of tables)assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n,0,`${table} is empty`);
 assert.equal(db.prepare("SELECT 1 FROM agent_task_runs_v2 WHERE status='awaiting_answer' LIMIT 1").get(),undefined,'runs waiting for an answer cannot be disguised as historical64');
 assert.equal(db.prepare("SELECT 1 FROM agent_task_steps_v2 WHERE status='awaiting_answer' LIMIT 1").get(),undefined,'questions waiting for an answer cannot be disguised as historical64');
 const objects=db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${[...names].map(()=>'?').join(',')}) ORDER BY type,name`).all(...names) as unknown as SchemaObject[];
 assert.deepEqual(objects.map(object=>({...object})),currentOrdinary66Delta.objects,'independent reviewed66 policy and answer SQL');
 const ownsTransaction=!db.isTransaction;if(ownsTransaction)db.exec('BEGIN IMMEDIATE');
 try{
  for(const object of currentOrdinary66Delta.objects)if(object.type==='trigger')db.exec(`DROP TRIGGER "${object.name}"`);
  for(const table of tables)db.exec(`DROP TABLE "${table}"`);
  db.exec('DELETE FROM schema_version WHERE version=66');
  if(ownsTransaction)db.exec('COMMIT');
 }catch(error){if(ownsTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}
