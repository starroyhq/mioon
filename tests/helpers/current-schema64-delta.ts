import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
interface CurrentOrdinary64Delta {
 readonly schemaVersionRows:readonly (readonly string[])[];readonly objects:readonly SchemaObject[];
 readonly tables:Readonly<Record<string,{fields:readonly string[];rows:0}>>;readonly catalog:{count:number;sha256:string};
}
/** Independently reviewed camera previs additions (schema64): receipt and
 * thumbnail tables with their guards, and two bounds triggers on the historical
 * nodes table. Frozen in tests/fixtures/workspace-schema-profiles/current-ordinary-64-delta.json.
 * Reviewed62 catalogs are unchanged once these exact definitions are excluded. */
export const currentOrdinary64Delta:CurrentOrdinary64Delta=JSON.parse(readFileSync(
 new URL('../fixtures/workspace-schema-profiles/current-ordinary-64-delta.json',import.meta.url),'utf8'));
const names=new Set(currentOrdinary64Delta.objects.map(object=>object.name));
export function withoutReviewedPrevisObjects<T extends SchemaObject>(objects:readonly T[]):T[] {
 const additions=objects.filter(object=>names.has(object.name));
 if(!additions.length)return [...objects];
 assert.deepEqual(additions.map(object=>({type:object.type,name:object.name,tbl_name:object.tbl_name,sql:object.sql})),currentOrdinary64Delta.objects,'independent reviewed64 previs SQL');
 return objects.filter(object=>!names.has(object.name));
}
/** Build genuine62 fixture bytes only when no previs rows or previs nodes
 * exist. Newer layers go first; use downgradeReviewedWorkspace from reviewed-schema-layers.ts. */
export function removeReviewedSchema64(db:DatabaseSync):void {
 if(!db.prepare('SELECT 1 FROM schema_version WHERE version=64').get())return;
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>64').get(),undefined,'newer reviewed layers are removed first');
 const tables=Object.keys(currentOrdinary64Delta.tables);
 for(const table of tables)assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n,0,`${table} is empty`);
 assert.equal(db.prepare("SELECT 1 FROM nodes WHERE json_valid(data) AND json_extract(data,'$.type')='previs' LIMIT 1").get(),undefined,'previs nodes cannot be disguised as historical62');
 const objects=db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${[...names].map(()=>'?').join(',')}) ORDER BY type,name`).all(...names) as unknown as SchemaObject[];
 assert.deepEqual(objects.map(object=>({...object})),currentOrdinary64Delta.objects,'independent reviewed64 previs SQL');
 const ownsTransaction=!db.isTransaction;if(ownsTransaction)db.exec('BEGIN IMMEDIATE');
 try{
  for(const object of currentOrdinary64Delta.objects)if(object.type==='trigger')db.exec(`DROP TRIGGER "${object.name}"`);
  for(const table of tables)db.exec(`DROP TABLE "${table}"`);
  db.exec('DELETE FROM schema_version WHERE version=64');
  if(ownsTransaction)db.exec('COMMIT');
 }catch(error){if(ownsTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}
