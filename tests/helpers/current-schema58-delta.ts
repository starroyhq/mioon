import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
interface CurrentOrdinary58Delta {
 readonly schemaVersionRows:readonly (readonly string[])[];readonly objects:readonly SchemaObject[];
 readonly tables:Readonly<Record<string,{fields:readonly string[];rows:0}>>;readonly catalog:{count:number;sha256:string};
}
/** Independently reviewed scene additions (schema58), frozen in
 * tests/fixtures/workspace-schema-profiles/current-ordinary-58-delta.json. Fixed56
 * catalogs remain unchanged; exclude these exact definitions only after checking them. */
export const currentOrdinary58Delta:CurrentOrdinary58Delta=JSON.parse(readFileSync(
 new URL('../fixtures/workspace-schema-profiles/current-ordinary-58-delta.json',import.meta.url),'utf8'));
export function withoutReviewedSceneObjects<T extends SchemaObject>(objects:readonly T[]):T[] {
 const names=new Set(currentOrdinary58Delta.objects.map(object=>object.name));
 assert.deepEqual(objects.filter(object=>names.has(object.name)).map(object=>({type:object.type,name:object.name,tbl_name:object.tbl_name,sql:object.sql})),currentOrdinary58Delta.objects,'independent reviewed58 scene SQL');
 return objects.filter(object=>!names.has(object.name));
}
/** Build genuine56 fixture bytes only when no scene rows exist. */
export function removeReviewedSchema58(db:DatabaseSync):void {
 const tables=Object.keys(currentOrdinary58Delta.tables);
 const objects=db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN (${tables.map(()=>'?').join(',')}) ORDER BY type,name`).all(...tables) as unknown as SchemaObject[];
 assert.deepEqual(withoutReviewedSceneObjects(objects),[]);
 for(const table of tables)assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n,0,`${table} is empty`);
 for(const object of currentOrdinary58Delta.objects)if(object.type==='trigger')db.exec(`DROP TRIGGER "${object.name}"`);
 for(const table of tables)db.exec(`DROP TABLE "${table}"`);
 db.exec('DELETE FROM schema_version WHERE version=58');
}
