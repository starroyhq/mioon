import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
interface ReplacedObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly before:string;readonly after:string}
interface CurrentOrdinary68Delta {
 readonly schemaVersionRows:readonly (readonly string[])[];readonly objects:readonly SchemaObject[];readonly removed:readonly SchemaObject[];
 readonly replaced:readonly ReplacedObject[];readonly tables:Readonly<Record<string,{fields:readonly string[];rows:0}>>;readonly catalog:{count:number;sha256:string};
}
/** Independently reviewed schema68 delta: the image_reviews rebuild that lets
 * edit intent v5 name a storyboard keyframe as its source. It adds and removes
 * no other object. Frozen in tests/fixtures/workspace-schema-profiles/current-ordinary-68-delta.json. */
export const currentOrdinary68Delta:CurrentOrdinary68Delta=JSON.parse(readFileSync(
 new URL('../fixtures/workspace-schema-profiles/current-ordinary-68-delta.json',import.meta.url),'utf8'));
const replaced=new Map(currentOrdinary68Delta.replaced.map(object=>[object.name,object]));
/** A68 catalog as its reviewed66 predecessor: the rebuilt image_reviews is
 * checked and its schema66 definition restored. A catalog already at 66 passes
 * through unchanged. */
export function withoutReviewedKeyframeEditObjects<T extends SchemaObject>(objects:readonly T[]):T[] {
 const current=objects.filter(object=>replaced.has(object.name)&&object.sql===replaced.get(object.name)!.after);
 if(!current.length)return [...objects];
 for(const object of objects)if(replaced.has(object.name))assert.equal(object.sql,replaced.get(object.name)!.after,`independent reviewed68 ${object.name} SQL`);
 // Keep SQLite's row prototype so strict comparisons with captured rows still hold.
 const like=(value:object):T=>Object.assign(Object.create(Object.getPrototypeOf(objects[0]??{})),value) as T;
 return objects.map(object=>replaced.has(object.name)?like({...object,sql:replaced.get(object.name)!.before}):object);
}
/** The reviewed68 catalog built from its reviewed66 predecessor. */
export function withReviewedKeyframeEditObjects(objects:readonly SchemaObject[]):SchemaObject[] {
 for(const object of objects)if(replaced.has(object.name))assert.equal(object.sql,replaced.get(object.name)!.before,`unchanged historical ${object.name} SQL`);
 return objects.map(object=>replaced.has(object.name)?{...object,sql:replaced.get(object.name)!.after}:object);
}
/** A test-only downgrade needs genuine66 evidence: no edit review whose source
 * is a storyboard keyframe. The image_reviews rebuild keeps rowids and dependent objects. */
export function removeReviewedSchema68(db:DatabaseSync):void {
 if(!db.prepare('SELECT 1 FROM schema_version WHERE version=68').get())return;
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>68').get(),undefined,'newer reviewed layers are removed first');
 assert.equal(db.prepare("SELECT 1 FROM image_reviews WHERE json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'scene-keyframe' LIMIT 1").get(),undefined,'keyframe edit reviews cannot be disguised as historical66');
 assert.equal(db.isTransaction,false,'the image review rebuild needs an isolated connection');
 const foreignKeys=(db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys;
 db.exec('PRAGMA foreign_keys=OFF');
 try{
  db.exec('BEGIN IMMEDIATE');
  const review=replaced.get('image_reviews')!,current=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='image_reviews'").get() as {sql:string};
  assert.equal(current.sql,review.after);
  const retained=db.prepare("SELECT name,sql FROM sqlite_schema WHERE tbl_name='image_reviews' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all() as {name:string;sql:string}[];
  const external=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name!='image_reviews' AND instr(lower(sql),'image_reviews')>0 ORDER BY name").all() as {name:string;sql:string}[];
  db.exec(review.before.replace(/^CREATE TABLE "image_reviews"\(/,'CREATE TABLE image_reviews_v66('));
  const columns=(db.prepare('PRAGMA table_info(image_reviews)').all() as {name:string}[]).map(row=>`"${row.name}"`).join(',');
  db.exec(`INSERT INTO image_reviews_v66(rowid,${columns}) SELECT rowid,${columns} FROM image_reviews ORDER BY rowid`);
  for(const trigger of external)db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec('DROP TABLE image_reviews; ALTER TABLE image_reviews_v66 RENAME TO image_reviews;');
  for(const object of [...retained,...external])db.exec(object.sql);
  assert.equal((db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='image_reviews'").get() as {sql:string}).sql,review.before);
  db.exec('DELETE FROM schema_version WHERE version=68');
  assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
  db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 finally{db.exec(`PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}`);}
}
