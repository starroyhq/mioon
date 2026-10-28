import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
interface ReplacedObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly before:string;readonly after:string}
interface CurrentOrdinary62Delta {
 readonly schemaVersionRows:readonly (readonly string[])[];readonly objects:readonly SchemaObject[];readonly removed:readonly SchemaObject[];
 readonly replaced:readonly ReplacedObject[];readonly tables:Readonly<Record<string,{fields:readonly string[];rows:0}>>;readonly catalog:{count:number;sha256:string};
}
/** Independently reviewed schema62 delta: subject variant tables, the
 * head-preserving subject identity guard and the image_reviews rebuild for
 * edit intent v5. Frozen in tests/fixtures/workspace-schema-profiles/current-ordinary-62-delta.json. */
export const currentOrdinary62Delta:CurrentOrdinary62Delta=JSON.parse(readFileSync(
 new URL('../fixtures/workspace-schema-profiles/current-ordinary-62-delta.json',import.meta.url),'utf8'));
const names=new Set(currentOrdinary62Delta.objects.map(object=>object.name));
const replaced=new Map(currentOrdinary62Delta.replaced.map(object=>[object.name,object]));
const order=(a:SchemaObject,b:SchemaObject)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0;
/** A62 catalog as its reviewed60 predecessor: additions are checked and
 * removed, replaced definitions are checked and restored, removed ones return. */
export function withoutReviewedSubjectVariantObjects<T extends SchemaObject>(objects:readonly T[]):T[] {
 const additions=objects.filter(object=>names.has(object.name));
 if(!additions.length)return [...objects];
 assert.deepEqual(additions.map(object=>({type:object.type,name:object.name,tbl_name:object.tbl_name,sql:object.sql})),currentOrdinary62Delta.objects,'independent reviewed62 subject variant SQL');
 for(const object of objects)if(replaced.has(object.name))assert.equal(object.sql,replaced.get(object.name)!.after,`independent reviewed62 ${object.name} SQL`);
 // Keep SQLite's row prototype so strict comparisons with captured rows still hold.
 const like=(value:object):T=>Object.assign(Object.create(Object.getPrototypeOf(objects[0]??{})),value) as T;
 const kept=objects.filter(object=>!names.has(object.name)).map(object=>replaced.has(object.name)?like({...object,sql:replaced.get(object.name)!.before}):object);
 return [...kept,...currentOrdinary62Delta.removed.map(object=>like(object))].sort(order);
}
/** A test-only downgrade needs genuine60 evidence: no variant rows and no v5
 * edit reviews. The image_reviews rebuild keeps rowids and dependent objects. */
export function removeReviewedSchema62(db:DatabaseSync):void {
 if(!db.prepare('SELECT 1 FROM schema_version WHERE version=62').get())return;
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version=63').get(),undefined);
 // Newer layers go first; use downgradeReviewedWorkspace from reviewed-schema-layers.ts.
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>63').get(),undefined,'newer reviewed layers are removed first');
 const tables=Object.keys(currentOrdinary62Delta.tables);
 for(const table of tables)assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n,0,`${table} is empty`);
 assert.equal(db.prepare("SELECT 1 FROM image_reviews WHERE json_extract(canonicalIntent,'$.schemaVersion') IS 5 LIMIT 1").get(),undefined,'v5 edit reviews cannot be disguised as historical60');
 assert.equal(db.isTransaction,false,'the image review rebuild needs an isolated connection');
 const foreignKeys=(db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys;
 db.exec('PRAGMA foreign_keys=OFF');
 try{
  db.exec('BEGIN IMMEDIATE');
  for(const object of currentOrdinary62Delta.objects)if(object.type==='trigger'&&!tables.includes(object.tbl_name))db.exec(`DROP TRIGGER "${object.name}"`);
  for(const table of tables)db.exec(`DROP TABLE "${table}"`);
  for(const object of currentOrdinary62Delta.removed)db.exec(object.sql!);
  const review=replaced.get('image_reviews')!,current=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='image_reviews'").get() as {sql:string};
  assert.equal(current.sql,review.after);
  const retained=db.prepare("SELECT name,sql FROM sqlite_schema WHERE tbl_name='image_reviews' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all() as {name:string;sql:string}[];
  const external=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name!='image_reviews' AND instr(lower(sql),'image_reviews')>0 ORDER BY name").all() as {name:string;sql:string}[];
  db.exec(review.before.replace(/^CREATE TABLE "image_reviews"\(/,'CREATE TABLE image_reviews_v60('));
  const columns=(db.prepare('PRAGMA table_info(image_reviews)').all() as {name:string}[]).map(row=>`"${row.name}"`).join(',');
  db.exec(`INSERT INTO image_reviews_v60(rowid,${columns}) SELECT rowid,${columns} FROM image_reviews ORDER BY rowid`);
  for(const trigger of external)db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec('DROP TABLE image_reviews; ALTER TABLE image_reviews_v60 RENAME TO image_reviews;');
  for(const object of [...retained,...external])db.exec(object.sql);
  assert.equal((db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='image_reviews'").get() as {sql:string}).sql,review.before);
  db.exec('DELETE FROM schema_version WHERE version=62');
  assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
  db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 finally{db.exec(`PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}`);}
}
/** The reviewed62 catalog built from its reviewed60 predecessor. */
export function withReviewedSubjectVariantObjects(objects:readonly SchemaObject[]):SchemaObject[] {
 assert.equal(objects.some(object=>names.has(object.name)),false);
 const removed=new Map(currentOrdinary62Delta.removed.map(object=>[object.name,object]));
 for(const object of objects)if(removed.has(object.name))assert.deepEqual({...object},removed.get(object.name),'unchanged historical subject identity guard');
 for(const object of objects)if(replaced.has(object.name))assert.equal(object.sql,replaced.get(object.name)!.before,`unchanged historical ${object.name} SQL`);
 return [...objects.filter(object=>!removed.has(object.name)).map(object=>replaced.has(object.name)?{...object,sql:replaced.get(object.name)!.after}:object),...currentOrdinary62Delta.objects].sort(order);
}
