import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {validateWorkspaceTransitionRows} from '../../packages/business/src/workspace-transition-validation.ts';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
interface CurrentOrdinary72Delta {
 readonly schemaVersionRows:readonly (readonly string[])[];readonly objects:readonly SchemaObject[];
 readonly tables:Readonly<Record<string,{fields:readonly string[];rows:0}>>;readonly catalog:{count:number;sha256:string};
}
/** Independently reviewed clip transition schema72: a marker-only layer, as
 * schema70 was for clip transforms. It adds no schema object; persisted clip
 * transitions are admitted by role from this marker on. Frozen in
 * tests/fixtures/workspace-schema-profiles/current-ordinary-72-delta.json. */
export const currentOrdinary72Delta:CurrentOrdinary72Delta=JSON.parse(readFileSync(
 new URL('../fixtures/workspace-schema-profiles/current-ordinary-72-delta.json',import.meta.url),'utf8'));
assert.equal(currentOrdinary72Delta.objects.length,0,'schema72 adds no schema object');
/** A72 catalog is its reviewed70 predecessor unchanged. */
export function withoutReviewedTransitionObjects<T extends SchemaObject>(objects:readonly T[]):T[] {return [...objects];}
export function withReviewedTransitionObjects(objects:readonly SchemaObject[]):SchemaObject[] {return [...objects];}
/** A test-only downgrade needs genuine70 evidence: no persisted transition and
 * no transition receipt anywhere. Newer layers go first; use
 * downgradeReviewedWorkspace from reviewed-schema-layers.ts. */
export function removeReviewedSchema72(db:DatabaseSync):void {
 if(!db.prepare('SELECT 1 FROM schema_version WHERE version=72').get())return;
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>72').get(),undefined,'newer reviewed layers are removed first');
 assert.doesNotThrow(()=>validateWorkspaceTransitionRows(db,{allowTransitions:false}),'clip transitions cannot be disguised as historical70');
 db.exec('DELETE FROM schema_version WHERE version=72');
}
